"""Background Indexing Pipeline and Backfill for CrestMeet Knowledge Base."""

import os
import sys
import json
import logging
from typing import Optional, List, Dict, Any
import psycopg
from dotenv import load_dotenv

from crestmeet_rag.chunking.chunker import SpeakerTurnChunker
from crestmeet_rag.embeddings.embedder import LocalEmbedder
from crestmeet_rag.models.schemas import ChunkRequest, TranscriptUtterance

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("crestmeet.indexing")

DEFAULT_DATABASE_URL = (
    "postgresql://postgres.yjqcxafjooyqfolnylwp:3t%5EQ9%21D-Ku%25t8uJ@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres"
)


def get_db_url() -> str:
    return os.getenv("DATABASE_URL") or os.getenv("SUPABASE_DB_URL") or DEFAULT_DATABASE_URL


class MeetingIndexer:
    """Handles chunking, embedding, insight extraction, and database persistence."""

    def __init__(self, db_url: Optional[str] = None):
        self.db_url = db_url or get_db_url()
        self.chunker = SpeakerTurnChunker()
        self.embedder = LocalEmbedder()

    def index_meeting(self, meeting_id: str) -> Dict[str, Any]:
        """Index a single meeting into knowledge_chunks and meeting_insights."""
        logger.info(f"Indexing meeting: {meeting_id}")

        with psycopg.connect(self.db_url) as conn:
            with conn.cursor() as cur:
                # 1. Fetch meeting info
                cur.execute(
                    """
                    SELECT m.id, m.title, m.created_at, m.project_id, COALESCE(p.name, 'Personal') as project_name
                    FROM meetings m
                    LEFT JOIN projects p ON m.project_id = p.id
                    WHERE m.id = %s
                    """,
                    (meeting_id,),
                )
                meeting_row = cur.fetchone()
                if not meeting_row:
                    raise ValueError(f"Meeting {meeting_id} not found")

                m_id, m_title, m_created_at, project_id, project_name = meeting_row

                # If project_id is None, assign to user's personal project or first project
                if not project_id:
                    cur.execute("SELECT id FROM projects WHERE is_personal = true LIMIT 1")
                    personal = cur.fetchone()
                    if personal:
                        project_id = personal[0]
                    else:
                        cur.execute("SELECT id FROM projects LIMIT 1")
                        first_p = cur.fetchone()
                        project_id = first_p[0] if first_p else None

                if not project_id:
                    raise ValueError("Cannot index meeting: No valid project_id found in database")

                # Update indexing_job status to 'running'
                cur.execute(
                    """
                    INSERT INTO indexing_jobs (meeting_id, project_id, stage, status, attempts, embedding_model)
                    VALUES (%s, %s, 'chunk', 'running', 1, %s)
                    ON CONFLICT (meeting_id) DO UPDATE SET
                        stage = 'chunk', status = 'running', attempts = indexing_jobs.attempts + 1, updated_at = NOW()
                    """,
                    (m_id, project_id, self.embedder.model_tag),
                )
                conn.commit()

                # 2. Fetch transcript utterances
                cur.execute(
                    """
                    SELECT id, COALESCE(speaker, 'Speaker') as speaker, transcript,
                           COALESCE(audio_start_time, 0.0), COALESCE(audio_end_time, 0.0)
                    FROM transcripts
                    WHERE meeting_id = %s
                    ORDER BY audio_start_time ASC, id ASC
                    """,
                    (meeting_id,),
                )
                transcript_rows = cur.fetchall()

                utterances: List[TranscriptUtterance] = []
                for row in transcript_rows:
                    t_id, spk, text, start_t, end_t = row
                    if text and text.strip():
                        utterances.append(
                            TranscriptUtterance(
                                id=str(t_id),
                                speaker=str(spk),
                                text=str(text).strip(),
                                start_seconds=float(start_t),
                                end_seconds=float(end_t),
                            )
                        )

                if not utterances:
                    logger.warning(f"Meeting {meeting_id} has no transcript lines. Skipping chunking.")
                    cur.execute(
                        """
                        UPDATE indexing_jobs
                        SET stage = 'done', status = 'succeeded', updated_at = NOW()
                        WHERE meeting_id = %s
                        """,
                        (m_id,),
                    )
                    conn.commit()
                    return {"meeting_id": m_id, "chunks_created": 0}

                # 3. Chunking
                date_str = m_created_at.strftime("%Y-%m-%d") if hasattr(m_created_at, "strftime") else str(m_created_at)[:10]
                chunk_req = ChunkRequest(
                    meeting_id=m_id,
                    meeting_title=m_title,
                    project_name=project_name,
                    meeting_date=date_str,
                    utterances=utterances,
                    target_tokens=300,
                    max_tokens=450,
                    overlap_turns=1,
                )
                chunks = self.chunker.chunk_meeting(chunk_req)
                logger.info(f"Generated {len(chunks)} chunks for meeting: {m_title}")

                # 4. Generate Embeddings
                texts_to_embed = [f"{c.context_header}\n{c.content}" for c in chunks]
                model_tag, _, vectors = self.embedder.embed_texts(texts_to_embed)

                # 5. Insert chunks into knowledge_chunks
                for chunk, vec in zip(chunks, vectors):
                    vec_str = "[" + ",".join(f"{x:.6f}" for x in vec) + "]"
                    cur.execute(
                        """
                        INSERT INTO knowledge_chunks (
                            project_id, meeting_id, source_type, chunk_index,
                            content, context_header, context_note, speakers,
                            start_seconds, end_seconds, first_transcript_id, last_transcript_id,
                            token_count, content_hash, embedding, embedding_model
                        ) VALUES (
                            %s, %s, 'transcript', %s,
                            %s, %s, %s, %s,
                            %s, %s, %s, %s,
                            %s, %s, %s::vector, %s
                        )
                        ON CONFLICT (meeting_id, source_type, chunk_index) DO UPDATE SET
                            content = EXCLUDED.content,
                            context_header = EXCLUDED.context_header,
                            speakers = EXCLUDED.speakers,
                            start_seconds = EXCLUDED.start_seconds,
                            end_seconds = EXCLUDED.end_seconds,
                            token_count = EXCLUDED.token_count,
                            content_hash = EXCLUDED.content_hash,
                            embedding = EXCLUDED.embedding,
                            embedding_model = EXCLUDED.embedding_model
                        """,
                        (
                            project_id,
                            m_id,
                            chunk.chunk_index,
                            chunk.content,
                            chunk.context_header,
                            chunk.context_note,
                            chunk.speakers,
                            chunk.start_seconds,
                            chunk.end_seconds,
                            chunk.first_transcript_id,
                            chunk.last_transcript_id,
                            chunk.token_count,
                            chunk.content_hash,
                            vec_str,
                            model_tag,
                        ),
                    )

                # 6. Extract insights from summary_processes if available
                cur.execute(
                    """
                    SELECT result FROM summary_processes WHERE meeting_id = %s AND status = 'completed'
                    """,
                    (m_id,),
                )
                summary_row = cur.fetchone()
                if summary_row and summary_row[0]:
                    try:
                        summary_json = json.loads(summary_row[0]) if isinstance(summary_row[0], str) else summary_row[0]
                        # Action items
                        action_items = summary_json.get("action_items") or []
                        for item in action_items:
                            text = item if isinstance(item, str) else item.get("description", str(item))
                            owner = item.get("assignee") if isinstance(item, dict) else None
                            cur.execute(
                                """
                                INSERT INTO meeting_insights (project_id, meeting_id, type, content, owner_name, status)
                                VALUES (%s, %s, 'action_item', %s, %s, 'open')
                                """,
                                (project_id, m_id, text, owner),
                            )
                        # Key decisions
                        decisions = summary_json.get("decisions") or []
                        for dec in decisions:
                            text = dec if isinstance(dec, str) else str(dec)
                            cur.execute(
                                """
                                INSERT INTO meeting_insights (project_id, meeting_id, type, content, status)
                                VALUES (%s, %s, 'decision', %s, 'open')
                                """,
                                (project_id, m_id, text),
                            )
                    except Exception as e:
                        logger.warning(f"Could not parse summary_processes JSON for {m_id}: {e}")

                # 7. Commit and mark indexing job as 'succeeded'
                cur.execute(
                    """
                    UPDATE indexing_jobs
                    SET stage = 'done', status = 'succeeded', last_error = NULL, updated_at = NOW()
                    WHERE meeting_id = %s
                    """,
                    (m_id,),
                )
                conn.commit()
                logger.info(f"✅ Successfully indexed meeting {m_id} ({len(chunks)} chunks)")

                return {
                    "meeting_id": m_id,
                    "title": m_title,
                    "project_id": str(project_id),
                    "chunks_created": len(chunks),
                    "status": "succeeded",
                }

    def index_all_meetings(self) -> Dict[str, Any]:
        """Backfill and index all existing meetings."""
        logger.info("Starting batch indexing for all meetings...")

        with psycopg.connect(self.db_url) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id, title FROM meetings ORDER BY created_at DESC")
                all_meetings = cur.fetchall()

        total = len(all_meetings)
        logger.info(f"Found {total} meetings to index.")

        successful = 0
        total_chunks = 0
        errors = []

        for idx, (m_id, m_title) in enumerate(all_meetings, 1):
            try:
                res = self.index_meeting(m_id)
                successful += 1
                total_chunks += res.get("chunks_created", 0)
                logger.info(f"Progress: [{idx}/{total}] Indexed '{m_title}'")
            except Exception as e:
                logger.error(f"Failed to index meeting '{m_title}' ({m_id}): {e}")
                errors.append({"meeting_id": m_id, "title": m_title, "error": str(e)})

        logger.info(
            f"🎉 Batch indexing finished: {successful}/{total} meetings indexed, {total_chunks} chunks stored."
        )

        return {
            "total_meetings": total,
            "successful": successful,
            "total_chunks": total_chunks,
            "errors": errors,
        }


def main():
    indexer = MeetingIndexer()
    if len(sys.argv) > 1 and sys.argv[1] != "--all":
        # Index specific meeting
        meeting_id = sys.argv[1]
        res = indexer.index_meeting(meeting_id)
        print(json.dumps(res, indent=2))
    else:
        # Index all meetings
        res = indexer.index_all_meetings()
        print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()

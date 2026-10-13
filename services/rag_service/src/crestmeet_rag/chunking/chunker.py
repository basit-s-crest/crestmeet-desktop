"""Speaker-turn aware transcript chunker for CrestMeet."""

import hashlib
from typing import List
import tiktoken

from crestmeet_rag.models.schemas import ChunkRequest, KnowledgeChunk, TranscriptUtterance


class SpeakerTurnChunker:
    """
    Chunks meeting transcripts respecting speaker turns and natural sentence boundaries.
    Ensures:
      - 250-350 tokens target window (hard cap 450).
      - 1-turn overlap between adjacent chunks to maintain context.
      - Start and end timestamps preserved.
      - Speaker labels preserved.
      - Deterministic context header prepended.
    """

    def __init__(self, encoding_name: str = "cl100k_base"):
        try:
            self.tokenizer = tiktoken.get_encoding(encoding_name)
        except Exception:
            self.tokenizer = tiktoken.get_encoding("gpt-4o")

    def count_tokens(self, text: str) -> int:
        """Count tokens using tiktoken."""
        return len(self.tokenizer.encode(text))

    def chunk_meeting(self, request: ChunkRequest) -> List[KnowledgeChunk]:
        """Convert a sequence of meeting utterances into enriched knowledge chunks."""
        utterances = [u for u in request.utterances if u.text.strip()]
        if not utterances:
            return []

        chunks: List[KnowledgeChunk] = []
        i = 0
        chunk_index = 0
        n = len(utterances)

        while i < n:
            current_window: List[TranscriptUtterance] = []
            current_tokens = 0
            j = i

            while j < n:
                utt = utterances[j]
                formatted_utt = f"{utt.speaker}: {utt.text.strip()}"
                utt_tokens = self.count_tokens(formatted_utt)

                # If adding this utterance exceeds max_tokens and we already have content, stop window
                if current_window and (current_tokens + utt_tokens > request.max_tokens):
                    break

                current_window.append(utt)
                current_tokens += utt_tokens
                j += 1

                # If we've reached the target token count and have at least 2 utterances, stop window
                if current_tokens >= request.target_tokens and len(current_window) >= 2:
                    break

            if not current_window:
                # In case single utterance is huge, advance at least by 1
                current_window = [utterances[i]]
                j = i + 1

            # Extract window metadata
            unique_speakers = list(dict.fromkeys(u.speaker for u in current_window))
            start_sec = current_window[0].start_seconds
            end_sec = current_window[-1].end_seconds
            first_id = current_window[0].id
            last_id = current_window[-1].id

            # Build content text
            content_lines = [f"{u.speaker}: {u.text.strip()}" for u in current_window]
            content = "\n".join(content_lines)

            # Deterministic Context Header: Project | Meeting | Date | Speakers
            speakers_str = ", ".join(unique_speakers) if unique_speakers else "Unknown"
            context_header = (
                f"Project: {request.project_name} | "
                f"Meeting: {request.meeting_title} | "
                f"Date: {request.meeting_date} | "
                f"Speakers: {speakers_str}"
            )

            # Compute SHA-256 hash for idempotency check
            content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()

            chunk = KnowledgeChunk(
                chunk_index=chunk_index,
                content=content,
                context_header=context_header,
                context_note=None,
                speakers=unique_speakers,
                start_seconds=start_sec,
                end_seconds=end_sec,
                token_count=self.count_tokens(content),
                content_hash=content_hash,
                first_transcript_id=first_id,
                last_transcript_id=last_id,
            )
            chunks.append(chunk)
            chunk_index += 1

            # Advance window with overlap
            # Overlap by requested turns, but always move forward by at least 1 utterance
            advance_step = max(1, len(current_window) - request.overlap_turns)
            if j >= n:
                break
            i += advance_step

        return chunks

"""FastAPI HTTP service for CrestMeet RAG."""

from typing import List
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from crestmeet_rag.chunking.chunker import SpeakerTurnChunker
from crestmeet_rag.embeddings.embedder import LocalEmbedder
from crestmeet_rag.models.schemas import (
    ChunkRequest,
    ChunkResponse,
    EmbedRequest,
    EmbedResponse,
    KnowledgeChunk,
)

app = FastAPI(
    title="CrestMeet RAG Service",
    description="Local service for transcript chunking and ONNX embeddings",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

chunker = SpeakerTurnChunker()
embedder = LocalEmbedder()


@app.get("/health")
def health():
    return {
        "status": "healthy",
        "embedding_model": embedder.model_tag,
        "dimension": embedder.dimension,
    }


@app.post("/chunk", response_model=ChunkResponse)
def chunk_transcript(request: ChunkRequest):
    try:
        chunks = chunker.chunk_meeting(request)
        return ChunkResponse(
            meeting_id=request.meeting_id,
            total_chunks=len(chunks),
            chunks=chunks,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Chunking error: {str(e)}")


@app.post("/embed", response_model=EmbedResponse)
def embed_texts(request: EmbedRequest):
    try:
        model_tag, dimension, embeddings = embedder.embed_texts(request.texts)
        return EmbedResponse(
            model=model_tag,
            dimension=dimension,
            embeddings=embeddings,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Embedding error: {str(e)}")


@app.post("/process-meeting", response_model=List[KnowledgeChunk])
def process_meeting(request: ChunkRequest):
    """
    Combined pipeline:
    1. Splits meeting into speaker-turn windows (250-350 tokens).
    2. Builds deterministic context headers.
    3. Computes vector embeddings on (header + content) using pinned local model.
    4. Returns fully prepared KnowledgeChunk records for Postgres insert.
    """
    try:
        chunks = chunker.chunk_meeting(request)
        if not chunks:
            return []

        # Prepare text to embed: "{context_header}\n{content}"
        texts_to_embed = [
            f"{c.context_header}\n{c.content}" for c in chunks
        ]

        model_tag, _, vectors = embedder.embed_texts(texts_to_embed)

        for chunk, vec in zip(chunks, vectors):
            chunk.embedding = vec
            chunk.embedding_model = model_tag

        return chunks
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Processing error: {str(e)}")


@app.post("/index-meeting/{meeting_id}")
def trigger_index_meeting(meeting_id: str):
    """Trigger background indexing for a single meeting."""
    try:
        from crestmeet_rag.indexing import MeetingIndexer
        indexer = MeetingIndexer()
        res = indexer.index_meeting(meeting_id)
        return res
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Indexing error: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("crestmeet_rag.api:app", host="127.0.0.1", port=8123, reload=False)


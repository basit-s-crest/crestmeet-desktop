import logging
import sys
import warnings
from typing import List

# Suppress known deprecated TorchAudio and Silero VAD library warnings
warnings.filterwarnings("ignore", category=UserWarning, module="torchaudio")
warnings.filterwarnings("ignore", category=DeprecationWarning, module="silero_vad")

# Ensure standard output logging is active if invoked via python -m crestmeet_rag.api
if not logging.getLogger().handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] [%(levelname)s] [%(name)s]: %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )
logging.getLogger("diarize").setLevel(logging.INFO)
logging.getLogger("crestmeet_rag").setLevel(logging.INFO)

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse

from crestmeet_rag.chunking.chunker import SpeakerTurnChunker
from crestmeet_rag.embeddings.embedder import LocalEmbedder
from crestmeet_rag.models.schemas import (
    ChunkRequest,
    ChunkResponse,
    EmbedRequest,
    EmbedResponse,
    KnowledgeChunk,
)
from crestmeet_rag.ocr.router import router as ocr_router
from crestmeet_rag.pyannote_3_0.router import router as diarize_router

tags_metadata = [
    {
        "name": "OCR & Screen Speaker Recognition",
        "description": "Verify screen OCR name extraction, app layout adapters (Teams, Zoom, Google Meet), attendee fuzzy matching, and Hungarian 1-to-1 voting solver.",
    },
    {
        "name": "Pyannote 3.1 ONNX Diarization",
        "description": "Production offline neural speaker diarization using Pyannote 3.1 powerset segmentation ONNX + WeSpeaker embeddings with calibrated cosine confidence, UNKNOWN thresholding, and anti-chaining average linkage.",
    },
    {
        "name": "RAG & Knowledge Chunking",
        "description": "Core speaker-turn chunking and FastEmbed ONNX embedding pipeline for meeting transcripts.",
    },
]

app = FastAPI(
    title="CrestMeet Backend & Model Verification Service",
    description="Local service for OCR screen recognition, Pyannote 3.1 ONNX diarization, and RAG chunking.",
    version="0.3.0",
    openapi_tags=tags_metadata,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount verification routers
app.include_router(ocr_router)
app.include_router(diarize_router)

chunker = SpeakerTurnChunker()
embedder = LocalEmbedder()


@app.get("/", include_in_schema=False)
def root():
    """Redirect root to OpenAPI interactive Swagger documentation."""
    return RedirectResponse(url="/docs")


@app.get("/health", tags=["RAG & Knowledge Chunking"])
def health():
    return {
        "status": "healthy",
        "embedding_model": embedder.model_tag,
        "dimension": embedder.dimension,
        "ocr_available": True,
        "diarization_engine": "pyannote/speaker-diarization-3.1 (ONNX Extended)",
        "pyannote_available": True,
    }


@app.post("/chunk", response_model=ChunkResponse, tags=["RAG & Knowledge Chunking"])
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


@app.post("/embed", response_model=EmbedResponse, tags=["RAG & Knowledge Chunking"])
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


@app.post("/process-meeting", response_model=List[KnowledgeChunk], tags=["RAG & Knowledge Chunking"])
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


@app.post("/index-meeting/{meeting_id}", tags=["RAG & Knowledge Chunking"])
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
    uvicorn.run("crestmeet_rag.api:app", host="127.0.0.1", port=8123, reload=True)

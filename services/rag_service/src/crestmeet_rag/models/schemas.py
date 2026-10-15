"""Pydantic schemas for chunking, embedding, and knowledge indexing."""

from typing import List, Optional
from pydantic import BaseModel, Field


class TranscriptUtterance(BaseModel):
    """A single utterance or spoken line from a meeting transcript."""
    id: Optional[str] = None
    speaker: str = "Speaker"
    text: str
    start_seconds: Optional[float] = None
    end_seconds: Optional[float] = None


class KnowledgeChunk(BaseModel):
    """A semantic chunk of a meeting transcript enriched with metadata."""
    chunk_index: int
    content: str
    context_header: Optional[str] = None
    context_note: Optional[str] = None
    speakers: List[str] = Field(default_factory=list)
    start_seconds: Optional[float] = None
    end_seconds: Optional[float] = None
    token_count: int = 0
    content_hash: str = ""
    first_transcript_id: Optional[str] = None
    last_transcript_id: Optional[str] = None
    embedding: Optional[List[float]] = None
    embedding_model: Optional[str] = None


class ChunkRequest(BaseModel):
    """Request payload to chunk a sequence of utterances."""
    meeting_id: str
    project_name: str = "General"
    meeting_title: str = "Meeting"
    meeting_date: str = ""
    utterances: List[TranscriptUtterance] = Field(default_factory=list)
    target_tokens: int = 300
    max_tokens: int = 450
    overlap_turns: int = 1


class ChunkResponse(BaseModel):
    """Response payload containing generated chunks."""
    meeting_id: str
    total_chunks: int
    chunks: List[KnowledgeChunk]


class EmbedRequest(BaseModel):
    """Request payload to embed text strings."""
    texts: List[str]


class EmbedResponse(BaseModel):
    """Response payload containing generated embeddings."""
    model: str
    dimension: int
    embeddings: List[List[float]]

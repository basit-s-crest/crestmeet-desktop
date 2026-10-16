"""Pydantic schemas for Pyannote diarization, segmentation, and speaker verification."""

from typing import List, Optional
from pydantic import BaseModel, Field


class PyannoteModelInfo(BaseModel):
    """Metadata about the Pyannote and WeSpeaker models configured."""
    segmentation_model: str = "pyannote/segmentation-3.0"
    embedding_model: str = "pyannote/wespeaker-voxceleb-resnet34"
    sample_rate_hz: int = 16000
    embedding_dimension: int = 512
    speaker_verification_threshold: float = 0.72
    status: str = "ready"


class AudioSpeechSegment(BaseModel):
    """A detected speech activity segment with start/end timestamps."""
    start_time: float = Field(..., description="Start timestamp in seconds")
    end_time: float = Field(..., description="End timestamp in seconds")
    duration: float = Field(..., description="Duration in seconds")
    speech_probability: float = Field(..., description="VAD / Speech probability (0-1)")


class SegmentationResponse(BaseModel):
    """Result of running Pyannote segmentation / VAD on an audio recording."""
    total_duration_seconds: float
    speech_duration_seconds: float
    speech_ratio: float
    segment_count: int
    segments: List[AudioSpeechSegment]


class SpeakerEmbeddingResponse(BaseModel):
    """Speaker embedding vector extracted from an audio segment."""
    model_name: str
    dimension: int
    vector_preview: List[float] = Field(..., description="First 10 dimensions for quick inspection")
    embedding: List[float] = Field(..., description="Complete normalized 512-dimensional vector")
    l2_norm: float
    duration_seconds: float


class SpeakerVerificationRequest(BaseModel):
    """Direct vector comparison request for two speaker embeddings."""
    embedding_a: List[float] = Field(..., description="512-dim embedding of Speaker A")
    embedding_b: List[float] = Field(..., description="512-dim embedding of Speaker B")
    threshold: float = Field(0.72, description="Similarity threshold for same-speaker decision")


class SpeakerVerificationResponse(BaseModel):
    """Result of speaker verification / cosine similarity match."""
    cosine_similarity: float
    is_same_speaker: bool
    confidence_level: str  # "high_match", "ambiguous", "distinct_speaker"
    verdict: str
    threshold: float


class DiarizedTurn(BaseModel):
    """A diarized speaker turn."""
    turn_id: int
    start_time: float
    end_time: float
    duration: float
    cluster_key: str  # "mic:S0", "sys:S1", "sys:S2"
    channel: str      # "mic" or "system"
    confidence: float


class ClusterSummary(BaseModel):
    """Summary of a clustered speaker identity."""
    cluster_key: str
    channel: str
    display_label: str
    turn_count: int
    total_spoken_seconds: float
    centroid_norm: float


class DiarizationResponse(BaseModel):
    """Complete offline diarization response for meeting audio."""
    total_duration_seconds: float
    speaker_clusters: List[ClusterSummary]
    diarized_turns: List[DiarizedTurn]
    processing_time_ms: float

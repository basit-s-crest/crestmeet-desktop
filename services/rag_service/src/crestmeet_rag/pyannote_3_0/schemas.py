"""Pydantic schemas for Pyannote 3.1 ONNX diarization."""

from typing import List, Optional
from pydantic import BaseModel, Field


class DiarizedTurn(BaseModel):
    """A diarized speaker turn."""
    turn_id: int
    start_time: float
    end_time: float
    duration: float
    cluster_key: str  # "mic:S0", "sys:S1", "sys:S2", "sys:UNKNOWN"
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

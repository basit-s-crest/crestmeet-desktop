"""Pydantic schemas for OCR verification and attendee matching."""

from enum import Enum
from typing import List, Optional
from pydantic import BaseModel, Field


class AppPreset(str, Enum):
    TEAMS = "teams"
    ZOOM = "zoom"
    GOOGLE_MEET = "google_meet"
    GENERIC = "generic"
    CUSTOM = "custom"


class NormalizedRoi(BaseModel):
    """Normalized Region of Interest (0.0 to 1.0 relative coordinates)."""
    x: float = Field(0.0, ge=0.0, le=1.0, description="Left coordinate (0-1)")
    y: float = Field(0.0, ge=0.0, le=1.0, description="Top coordinate (0-1)")
    width: float = Field(1.0, gt=0.0, le=1.0, description="Width (0-1)")
    height: float = Field(1.0, gt=0.0, le=1.0, description="Height (0-1)")


class OcrTextLine(BaseModel):
    """A recognized text line from OCR."""
    text: str
    confidence: float = 1.0
    bounding_box: Optional[dict] = None


class OcrRecognizeRequest(BaseModel):
    """Payload for OCR recognition on an image (base64 string or URI)."""
    image_base64: str = Field(..., description="Base64 encoded image data (with or without data URL header)")
    app_preset: AppPreset = Field(AppPreset.GENERIC, description="App layout preset for active speaker badges")
    custom_roi: Optional[NormalizedRoi] = Field(None, description="Custom ROI to crop before OCR (overrides preset)")
    attendee_names: List[str] = Field(default_factory=list, description="Calendar attendee names to fuzzy-match against")
    extra_strip_tokens: List[str] = Field(default_factory=list, description="Extra tokens to strip like '(Speaker)', 'Guest'")


class OcrRecognizeResponse(BaseModel):
    """Result of OCR recognition and name resolution."""
    app_preset: str
    raw_full_text: str
    detected_lines: List[OcrTextLine]
    cleaned_name: str
    matched_attendee: Optional[str] = None
    similarity_score: float = 0.0
    ocr_confidence: float = 0.0
    combined_score: float = 0.0
    should_auto_commit: bool = False
    suggested_chip: Optional[str] = None
    active_speaker_detected: bool = False
    active_speaker_name: Optional[str] = None
    all_grid_names: List[str] = Field(default_factory=list)


class FuzzyMatchRequest(BaseModel):
    """Test attendee fuzzy matching on candidate text."""
    raw_ocr_text: str = Field(..., example="Sarah Connor (You)")
    attendee_names: List[str] = Field(
        default=["Sarah Connor", "John Doe", "Alex Rivera", "David Miller"],
        description="Known team or calendar attendee names"
    )
    commit_threshold: float = Field(0.75, ge=0.0, le=1.0, description="Threshold to auto-commit name")
    suggestion_threshold: float = Field(0.50, ge=0.0, le=1.0, description="Threshold to offer as suggested chip")


class FuzzyMatchResponse(BaseModel):
    """Fuzzy matching test result."""
    raw_text: str
    cleaned_text: str
    best_match: Optional[str] = None
    similarity_score: float
    is_auto_commit: bool
    is_suggested: bool
    suggestion_chip: Optional[str] = None
    all_scores: dict[str, float] = Field(default_factory=dict)


class OcrObservationInput(BaseModel):
    """Individual OCR observation for a speaker cluster."""
    cluster_key: str = Field(..., example="sys:S1")
    raw_text: str = Field(..., example="Alex Rivera (Presenting)")
    candidate_name: str = Field(..., example="Alex Rivera")
    ocr_confidence: float = Field(0.90, ge=0.0, le=1.0)
    match_similarity: float = Field(0.88, ge=0.0, le=1.0)
    segment_purity: float = Field(0.95, ge=0.0, le=1.0)
    timestamp: float = Field(12.5, description="Video timestamp in seconds")


class VotingSimulationRequest(BaseModel):
    """Test the Hungarian 1-to-1 voting algorithm on OCR observations."""
    observations: List[OcrObservationInput]
    unresolved_clusters: List[str] = Field(default=["sys:S1", "sys:S2"])
    auto_commit_threshold: float = Field(0.70, description="Min quality score to auto-commit")
    suggestion_threshold: float = Field(0.45, description="Min quality score to attach suggestion chip")
    margin_threshold: float = Field(0.15, description="Lead margin over runner-up needed to commit")


class SpeakerDecision(BaseModel):
    cluster_key: str
    committed_name: Optional[str] = None
    suggested_name: Optional[str] = None
    confidence: float
    vote_count: int
    runner_up_name: Optional[str] = None
    runner_up_score: float = 0.0


class VotingSimulationResponse(BaseModel):
    decisions: List[SpeakerDecision]
    total_clusters: int
    auto_committed_count: int
    suggested_count: int
    unresolved_count: int


class MeetingFrameInput(BaseModel):
    """Candidate video or native screen capture frame."""
    frame_id: str
    cluster_key: str
    timestamp: float
    image_base64: str


class MeetingSegmentInput(BaseModel):
    """Transcript turn segment with audio timestamps and recognized text."""
    cluster_key: str
    start_time: float
    end_time: float
    transcript_text: str


class ResolveMeetingSpeakersRequest(BaseModel):
    """Request payload for multi-modal OCR speaker resolution across meeting frames and transcripts."""
    meeting_id: str
    frames: List[MeetingFrameInput]
    segments: List[MeetingSegmentInput] = Field(default_factory=list)
    attendees: List[str] = Field(default_factory=list)
    app_preset: AppPreset = AppPreset.GENERIC


class ClusterResolution(BaseModel):
    """Final decision for an individual speaker cluster."""
    cluster_key: str
    committed_name: Optional[str] = None
    suggested_name: Optional[str] = None
    confidence: float = 0.0
    evidence_count: int = 0
    reasons: List[str] = Field(default_factory=list)
    evidence_types: int = 0
    raw_ocr_names: List[str] = Field(default_factory=list)
    runner_up_name: Optional[str] = None
    runner_up_score: float = 0.0


class ResolveMeetingSpeakersResponse(BaseModel):
    """Full meeting resolution response including per-cluster decisions and the complete audit dossier."""
    meeting_id: str
    decisions: List[ClusterResolution]
    dossier: dict
    total_clusters_resolved: int
    auto_committed_count: int
    suggested_count: int


// frontend/src-tauri/src/diarization/models.rs

use serde::{Deserialize, Serialize};

/// Represents an individual diarized speech segment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiarizedSegment {
    /// Start time in seconds from recording beginning
    pub start_time: f64,
    /// End time in seconds from recording beginning
    pub end_time: f64,
    /// Cluster key, e.g. "mic:S0", "sys:S1", "sys:S2"
    pub cluster_key: String,
    /// Channel name: "mic" or "system"
    pub channel: String,
    /// Confidence of speaker attribution (0.0 - 1.0)
    pub confidence: f32,
    /// Optional speaker embedding vector for this segment
    pub embedding: Option<Vec<f32>>,
}

/// Summary and centroid embedding for a diarized speaker cluster
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeakerClusterSummary {
    /// Cluster key, e.g. "mic:S0", "sys:S1"
    pub cluster_key: String,
    /// Channel: "mic" or "system"
    pub channel: String,
    /// Cluster centroid embedding vector (e.g. 512-dim or 256-dim)
    pub centroid_embedding: Vec<f32>,
    /// Embedding model identifier (e.g. "pyannote/wespeaker-voxceleb")
    pub embedding_model: String,
    /// Number of speech segments in this cluster
    pub segment_count: usize,
    /// Total spoken duration in seconds
    pub total_duration: f64,
    /// Default display label (e.g. "You" for mic:S0, "Speaker 1" for sys:S1)
    pub default_label: String,
}

/// Full result of the offline diarization process
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiarizationResult {
    /// Meeting ID this diarization belongs to
    pub meeting_id: String,
    /// Individual diarized speech segments
    pub segments: Vec<DiarizedSegment>,
    /// Extracted clusters with centroid embeddings
    pub clusters: Vec<SpeakerClusterSummary>,
    /// Diarization execution duration in milliseconds
    pub processing_time_ms: u64,
}

/// Status of diarization for a meeting
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiarizationStatus {
    pub meeting_id: String,
    pub status: String, // "pending", "processing", "completed", "failed"
    pub progress: u8,
    pub error: Option<String>,
    pub speaker_count: usize,
}

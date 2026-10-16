// frontend/src-tauri/src/diarization/config.rs

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiarizationConfig {
    /// Distance threshold for agglomerative hierarchical clustering (cosine distance)
    /// 0.0 to 1.0; default 0.65 (similarity >= 0.35)
    pub clustering_threshold: f32,
    /// Minimum duration of speech segment in seconds to be kept as valid
    pub min_duration_on: f64,
    /// Minimum silence duration in seconds to consider speaker turns separated
    pub min_duration_off: f64,
    /// Expected audio sample rate in Hz
    pub sample_rate: u32,
    /// Model name/path for segmentation (pyannote ONNX)
    pub segmentation_model: String,
    /// Model name/path for speaker embedding (3D-Speaker / WeSpeaker ONNX)
    pub embedding_model: String,
    /// Embedding vector dimension
    pub embedding_dim: usize,
    /// Echo cancellation similarity threshold (0.0 - 1.0)
    pub echo_similarity_threshold: f32,
    /// Time window in seconds for echo checking between mic and system
    pub echo_window_seconds: f64,
}

impl Default for DiarizationConfig {
    fn default() -> Self {
        Self {
            clustering_threshold: 0.65,
            min_duration_on: 0.3,
            min_duration_off: 0.5,
            sample_rate: 16000,
            segmentation_model: "pyannote/segmentation-3.0".to_string(),
            embedding_model: "wespeaker-voxceleb-resnet34".to_string(),
            embedding_dim: 512,
            echo_similarity_threshold: 0.75,
            echo_window_seconds: 1.5,
        }
    }
}

/// Compute cosine similarity between two float vectors
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }

    let mut dot_product = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;

    for (x, y) in a.iter().zip(b.iter()) {
        dot_product += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }

    let denominator = (norm_a.sqrt() * norm_b.sqrt()).max(1e-9);
    dot_product / denominator
}

/// Compute the L2-normalized mean centroid of a collection of embeddings
pub fn compute_centroid(embeddings: &[Vec<f32>], dim: usize) -> Vec<f32> {
    if embeddings.is_empty() {
        return vec![0.0; dim];
    }

    let mut centroid = vec![0.0f32; dim];
    for emb in embeddings {
        for (i, val) in emb.iter().enumerate().take(dim) {
            centroid[i] += val;
        }
    }

    let count = embeddings.len() as f32;
    for val in &mut centroid {
        *val /= count;
    }

    // L2 normalize
    let norm: f32 = centroid.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
    for val in &mut centroid {
        *val /= norm;
    }

    centroid
}

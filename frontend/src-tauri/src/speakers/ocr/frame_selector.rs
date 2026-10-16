// frontend/src-tauri/src/speakers/ocr/frame_selector.rs

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateSpeechSegment {
    pub cluster_key: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub duration: f64,
    pub confidence: f32,
    pub is_clean: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectedFrameTarget {
    pub cluster_key: String,
    pub segment_start: f64,
    pub segment_end: f64,
    pub seek_seconds: f64,
    pub frame_index: usize,
}

pub struct FrameSelector {
    min_segment_duration: f64,
    max_frames_per_cluster: usize,
    max_total_frames: usize,
}

impl Default for FrameSelector {
    fn default() -> Self {
        Self {
            min_segment_duration: 2.0, // clean speech >= 2 seconds
            max_frames_per_cluster: 3, // top 3 clean segments
            max_total_frames: 25,      // meeting cap to avoid excess CPU
        }
    }
}

impl FrameSelector {
    pub fn new(min_duration: f64, max_per_cluster: usize, max_total: usize) -> Self {
        Self {
            min_segment_duration: min_duration,
            max_frames_per_cluster: max_per_cluster,
            max_total_frames: max_total,
        }
    }

    /// Selects clean frame midpoint timestamps for unresolved clusters
    pub fn select_frames_for_clusters(
        &self,
        unresolved_clusters: &[String],
        all_segments: &[CandidateSpeechSegment],
        video_offset_seconds: f64,
    ) -> Vec<SelectedFrameTarget> {
        let mut selected_targets = Vec::new();

        for cluster in unresolved_clusters {
            // Filter segments belonging to this cluster that are clean and >= min duration
            let mut cluster_segments: Vec<&CandidateSpeechSegment> = all_segments
                .iter()
                .filter(|s| &s.cluster_key == cluster && s.is_clean && s.duration >= self.min_segment_duration)
                .collect();

            // Rank longest segments first
            cluster_segments.sort_by(|a, b| b.duration.partial_cmp(&a.duration).unwrap_or(std::cmp::Ordering::Equal));

            // Take top N segments
            for (idx, seg) in cluster_segments.iter().take(self.max_frames_per_cluster).enumerate() {
                if selected_targets.len() >= self.max_total_frames {
                    break;
                }

                // Midpoint timestamp safely inside the speech segment
                let midpoint = seg.start_seconds + (seg.duration / 2.0);
                let seek_time = (midpoint + video_offset_seconds).max(0.0);

                selected_targets.push(SelectedFrameTarget {
                    cluster_key: cluster.clone(),
                    segment_start: seg.start_seconds,
                    segment_end: seg.end_seconds,
                    seek_seconds: seek_time,
                    frame_index: idx,
                });
            }
        }

        selected_targets
    }
}

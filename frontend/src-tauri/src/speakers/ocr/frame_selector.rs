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
    onset_delay: f64,
    min_cluster_gap: f64,
    max_frames_per_cluster: usize,
    max_total_frames: usize,
}

impl Default for FrameSelector {
    fn default() -> Self {
        Self {
            min_segment_duration: 1.2, // Clean speech >= 1.2s to be eligible
            onset_delay: 0.9,          // Sample 0.9s into the turn for active-speaker highlight stability
            min_cluster_gap: 60.0,     // Spread rule: at least 60s between frames of the same speaker
            max_frames_per_cluster: 3, // At most 3 frames per speaker
            max_total_frames: 30,      // Meeting budget cap
        }
    }
}

impl FrameSelector {
    pub fn new(
        min_duration: f64,
        onset_delay: f64,
        min_cluster_gap: f64,
        max_per_cluster: usize,
        max_total: usize,
    ) -> Self {
        Self {
            min_segment_duration: min_duration,
            onset_delay,
            min_cluster_gap,
            max_frames_per_cluster: max_per_cluster,
            max_total_frames: max_total,
        }
    }

    /// Selects clean frame timestamps adhering to the single-frame-per-segment policy:
    /// 1. Always captures the first eligible clean segment of every new speaker.
    /// 2. Spreads subsequent frames at least `min_cluster_gap` (60s) apart.
    /// 3. Targets `onset + onset_delay` (0.9s) rather than midpoint for highlight stability.
    pub fn select_frames_for_clusters(
        &self,
        unresolved_clusters: &[String],
        all_segments: &[CandidateSpeechSegment],
        video_offset_seconds: f64,
    ) -> Vec<SelectedFrameTarget> {
        let mut selected_targets = Vec::new();

        // Sort all segments chronologically
        let mut chronological_segments: Vec<&CandidateSpeechSegment> = all_segments
            .iter()
            .filter(|s| s.is_clean && s.duration >= self.min_segment_duration)
            .collect();
        chronological_segments.sort_by(|a, b| {
            a.start_seconds
                .partial_cmp(&b.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        use std::collections::HashMap;
        let mut last_capture_time_by_cluster: HashMap<String, f64> = HashMap::new();
        let mut count_by_cluster: HashMap<String, usize> = HashMap::new();

        for seg in chronological_segments {
            if !unresolved_clusters.contains(&seg.cluster_key) {
                continue;
            }

            if selected_targets.len() >= self.max_total_frames {
                break;
            }

            let cluster = &seg.cluster_key;
            let current_count = *count_by_cluster.get(cluster).unwrap_or(&0);
            if current_count >= self.max_frames_per_cluster {
                continue;
            }

            let is_first_segment = current_count == 0;
            let last_time = last_capture_time_by_cluster.get(cluster).copied().unwrap_or(-999.0);
            let time_since_last = seg.start_seconds - last_time;

            if is_first_segment || time_since_last >= self.min_cluster_gap {
                // Optimal seek timestamp: onset + onset_delay, clamped inside the segment
                let seek_relative = (seg.start_seconds + self.onset_delay)
                    .min(seg.end_seconds - 0.2)
                    .max(seg.start_seconds);
                let seek_time = (seek_relative + video_offset_seconds).max(0.0);

                selected_targets.push(SelectedFrameTarget {
                    cluster_key: cluster.clone(),
                    segment_start: seg.start_seconds,
                    segment_end: seg.end_seconds,
                    seek_seconds: seek_time,
                    frame_index: current_count,
                });

                last_capture_time_by_cluster.insert(cluster.clone(), seg.start_seconds);
                count_by_cluster.insert(cluster.clone(), current_count + 1);
            }
        }

        selected_targets
    }
}

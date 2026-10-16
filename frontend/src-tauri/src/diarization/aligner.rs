// frontend/src-tauri/src/diarization/aligner.rs

use super::config::DiarizationConfig;
use super::models::DiarizedSegment;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawTranscriptTurn {
    pub id: String,
    pub text: String,
    pub start_time: f64,
    pub end_time: f64,
    pub channel: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlignedTurn {
    pub id: String,
    pub text: String,
    pub start_time: f64,
    pub end_time: f64,
    pub cluster_key: String,
    pub channel: String,
    pub speaker_confidence: f32,
    pub is_echo: bool,
}

pub struct TranscriptAligner {
    config: DiarizationConfig,
}

impl TranscriptAligner {
    pub fn new(config: DiarizationConfig) -> Self {
        Self { config }
    }

    /// Aligns transcript segments with diarization output and performs echo filtering
    pub fn align_and_filter_echo(
        &self,
        raw_turns: &[RawTranscriptTurn],
        diarized_segments: &[DiarizedSegment],
    ) -> Vec<AlignedTurn> {
        let mut aligned_turns = Vec::new();

        // Separate diarized segments by channel for fast lookup
        let mic_segments: Vec<&DiarizedSegment> = diarized_segments
            .iter()
            .filter(|s| s.channel == "mic")
            .collect();

        let sys_segments: Vec<&DiarizedSegment> = diarized_segments
            .iter()
            .filter(|s| s.channel == "system")
            .collect();

        for turn in raw_turns {
            let channel = turn.channel.as_deref().unwrap_or("system");
            let target_segments = if channel == "mic" {
                &mic_segments
            } else {
                &sys_segments
            };

            // Find best matching diarized segment based on maximum temporal overlap
            let mut best_match: Option<(&DiarizedSegment, f64)> = None;

            for segment in target_segments {
                let overlap_start = turn.start_time.max(segment.start_time);
                let overlap_end = turn.end_time.min(segment.end_time);
                let overlap = (overlap_end - overlap_start).max(0.0);

                if overlap > 0.0 {
                    if let Some((_, best_overlap)) = best_match {
                        if overlap > best_overlap {
                            best_match = Some((segment, overlap));
                        }
                    } else {
                        best_match = Some((segment, overlap));
                    }
                }
            }

            let (cluster_key, confidence) = if let Some((matched, overlap)) = best_match {
                let turn_len = (turn.end_time - turn.start_time).max(0.1);
                let overlap_ratio = (overlap / turn_len).min(1.0) as f32;
                let conf = (matched.confidence * overlap_ratio).max(0.2);
                (matched.cluster_key.clone(), conf)
            } else {
                // Fallback: assign to primary channel cluster with lower confidence
                let fallback_cluster = if channel == "mic" {
                    "mic:S0".to_string()
                } else {
                    "sys:S1".to_string()
                };
                (fallback_cluster, 0.4f32)
            };

            aligned_turns.push(AlignedTurn {
                id: turn.id.clone(),
                text: turn.text.clone(),
                start_time: turn.start_time,
                end_time: turn.end_time,
                cluster_key,
                channel: channel.to_string(),
                speaker_confidence: confidence,
                is_echo: false,
            });
        }

        // Echo filtering: detect mic turns that are simply echo of system speech
        self.detect_and_flag_echo(&mut aligned_turns);

        aligned_turns
    }

    /// Detects mic speech turns that closely match system speech in a near time window
    fn detect_and_flag_echo(&self, turns: &mut [AlignedTurn]) {
        let n = turns.len();
        for i in 0..n {
            if turns[i].channel != "mic" {
                continue;
            }

            let mic_start = turns[i].start_time;
            let mic_end = turns[i].end_time;
            let mic_text = normalize_text(&turns[i].text);

            if mic_text.len() < 3 {
                continue;
            }

            // Look for overlapping or preceding system speech within echo window
            for j in 0..n {
                if turns[j].channel != "system" {
                    continue;
                }

                let sys_start = turns[j].start_time;
                let sys_end = turns[j].end_time;

                let window_start = sys_start - 0.5;
                let window_end = sys_end + self.config.echo_window_seconds;

                if mic_start >= window_start && mic_end <= window_end {
                    let sys_text = normalize_text(&turns[j].text);
                    let similarity = string_similarity(&mic_text, &sys_text);

                    if similarity >= self.config.echo_similarity_threshold {
                        turns[i].is_echo = true;
                        // Reduce confidence to minimum or flag as echo
                        turns[i].speaker_confidence = 0.1;
                        break;
                    }
                }
            }
        }
    }
}

/// Helper to normalize text for comparison
fn normalize_text(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect()
}

/// Helper for word-based Jaccard similarity between two strings
fn string_similarity(a: &str, b: &str) -> f32 {
    let words_a: std::collections::HashSet<&str> = a.split_whitespace().collect();
    let words_b: std::collections::HashSet<&str> = b.split_whitespace().collect();

    if words_a.is_empty() || words_b.is_empty() {
        return 0.0;
    }

    let intersection = words_a.intersection(&words_b).count();
    let union = words_a.union(&words_b).count();

    if union == 0 {
        return 0.0;
    }

    intersection as f32 / union as f32
}

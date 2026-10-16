// frontend/src-tauri/src/speakers/ocr/voting.rs

use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrObservation {
    pub cluster_key: String,
    pub raw_text: String,
    pub candidate_name: String,
    pub ocr_confidence: f32,
    pub match_similarity: f32,
    pub segment_purity: f32,
    pub timestamp: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterNamingDecision {
    pub cluster_key: String,
    pub committed_name: Option<String>,
    pub suggested_name: Option<String>,
    pub confidence: f32,
    pub vote_count: usize,
    pub is_auto_committed: bool,
}

pub struct OcrVotingSystem {
    commit_threshold: f32,
    margin_threshold: f32,
    min_observations: usize,
}

impl Default for OcrVotingSystem {
    fn default() -> Self {
        Self {
            commit_threshold: 0.65,
            margin_threshold: 0.15,
            min_observations: 2,
        }
    }
}

impl OcrVotingSystem {
    pub fn new(commit_threshold: f32, margin_threshold: f32, min_observations: usize) -> Self {
        Self {
            commit_threshold,
            margin_threshold,
            min_observations,
        }
    }

    /// Fuzzy-match candidate OCR string against known calendar attendees
    pub fn match_against_attendees<'a>(
        &self,
        cleaned_ocr_text: &str,
        attendees: &'a [String],
    ) -> Option<(&'a String, f32)> {
        let norm_ocr = cleaned_ocr_text.to_lowercase();
        if norm_ocr.is_empty() || norm_ocr.len() < 2 {
            return None;
        }

        let mut best_match: Option<(&'a String, f32)> = None;

        for attendee in attendees {
            let norm_attendee = attendee.to_lowercase();
            let score = compute_string_similarity(&norm_ocr, &norm_attendee);

            if let Some((_, best_score)) = best_match {
                if score > best_score {
                    best_match = Some((attendee, score));
                }
            } else {
                best_match = Some((attendee, score));
            }
        }

        // Return best match if it clears baseline similarity threshold (0.60)
        best_match.filter(|(_, score)| *score >= 0.60)
    }

    /// Aggregate observations, vote per cluster, and enforce 1-to-1 assignment
    pub fn resolve_decisions(
        &self,
        observations: &[OcrObservation],
        unresolved_clusters: &[String],
    ) -> Vec<ClusterNamingDecision> {
        // Step 1: Accumulate quality score: q = ocr_confidence * match_similarity * segment_purity
        // M[cluster_key][candidate_name] = total_q
        let mut votes: HashMap<String, HashMap<String, (f32, usize)>> = HashMap::new();

        for obs in observations {
            let q = (obs.ocr_confidence * obs.match_similarity * obs.segment_purity).max(0.01);
            let cluster_entry = votes.entry(obs.cluster_key.clone()).or_default();
            let name_entry = cluster_entry.entry(obs.candidate_name.clone()).or_insert((0.0, 0));
            name_entry.0 += q;
            name_entry.1 += 1;
        }

        // Step 2: For each cluster, find top candidate and runner-up
        let mut cluster_candidates: Vec<(String, String, f32, f32, usize)> = Vec::new(); // (cluster, name, top_score, margin, count)

        for cluster in unresolved_clusters {
            if let Some(candidate_map) = votes.get(cluster) {
                let mut sorted: Vec<(&String, &(f32, usize))> = candidate_map.iter().collect();
                sorted.sort_by(|a, b| b.1 .0.partial_cmp(&a.1 .0).unwrap_or(std::cmp::Ordering::Equal));

                if let Some((top_name, (top_score, count))) = sorted.first() {
                    let total_cluster_score: f32 = sorted.iter().map(|(_, (s, _))| s).sum();
                    let runner_up_score = sorted.get(1).map(|(_, (s, _))| s).copied().unwrap_or(0.0);

                    let relative_share = if total_cluster_score > 0.0 {
                        top_score / total_cluster_score
                    } else {
                        0.0
                    };

                    let margin = if total_cluster_score > 0.0 {
                        (top_score - runner_up_score) / total_cluster_score
                    } else {
                        0.0
                    };

                    cluster_candidates.push((
                        cluster.clone(),
                        (*top_name).clone(),
                        relative_share,
                        margin,
                        *count,
                    ));
                }
            }
        }

        // Step 3: Greedy 1-to-1 assignment (so two clusters cannot claim the same person)
        // Sort candidates by highest score
        cluster_candidates.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

        let mut claimed_names: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut decisions: HashMap<String, ClusterNamingDecision> = HashMap::new();

        for (cluster, name, share, margin, count) in cluster_candidates {
            if claimed_names.contains(&name) {
                // Name already claimed by another stronger cluster; downgrade to suggestion
                decisions.insert(
                    cluster.clone(),
                    ClusterNamingDecision {
                        cluster_key: cluster,
                        committed_name: None,
                        suggested_name: Some(name),
                        confidence: share * 0.7,
                        vote_count: count,
                        is_auto_committed: false,
                    },
                );
                continue;
            }

            // Check auto-commit threshold
            let can_commit = share >= self.commit_threshold
                && margin >= self.margin_threshold
                && count >= self.min_observations;

            if can_commit {
                claimed_names.insert(name.clone());
                decisions.insert(
                    cluster.clone(),
                    ClusterNamingDecision {
                        cluster_key: cluster,
                        committed_name: Some(name.clone()),
                        suggested_name: None,
                        confidence: share,
                        vote_count: count,
                        is_auto_committed: true,
                    },
                );
            } else {
                decisions.insert(
                    cluster.clone(),
                    ClusterNamingDecision {
                        cluster_key: cluster,
                        committed_name: None,
                        suggested_name: Some(name),
                        confidence: share,
                        vote_count: count,
                        is_auto_committed: false,
                    },
                );
            }
        }

        // Include any remaining unresolved clusters that had 0 observations
        for cluster in unresolved_clusters {
            decisions.entry(cluster.clone()).or_insert_with(|| ClusterNamingDecision {
                cluster_key: cluster.clone(),
                committed_name: None,
                suggested_name: None,
                confidence: 0.0,
                vote_count: 0,
                is_auto_committed: false,
            });
        }

        decisions.into_values().collect()
    }
}

/// Jaro-Winkler-like character trigram similarity for robust attendee matching
fn compute_string_similarity(a: &str, b: &str) -> f32 {
    if a == b {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }

    // Exact sub-phrase check (e.g. "Alex" in "Alex Mercer")
    if a.contains(b) || b.contains(a) {
        let min_len = a.len().min(b.len()) as f32;
        let max_len = a.len().max(b.len()) as f32;
        return (min_len / max_len).max(0.75);
    }

    // Trigram character set overlap
    let grams_a = get_trigrams(a);
    let grams_b = get_trigrams(b);

    if grams_a.is_empty() || grams_b.is_empty() {
        return 0.0;
    }

    let intersection = grams_a.intersection(&grams_b).count();
    let union = grams_a.union(&grams_b).count();

    if union == 0 {
        return 0.0;
    }

    intersection as f32 / union as f32
}

fn get_trigrams(s: &str) -> std::collections::HashSet<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut set = std::collections::HashSet::new();
    if chars.len() < 3 {
        set.insert(s.to_string());
        return set;
    }
    for window in chars.windows(3) {
        set.insert(window.iter().collect());
    }
    set
}

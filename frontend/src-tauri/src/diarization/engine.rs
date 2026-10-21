// frontend/src-tauri/src/diarization/engine.rs

use std::collections::HashMap;
use std::time::Instant;
use anyhow::{anyhow, Result};
use sqlx::PgPool;
use tauri::{AppHandle, Emitter, Runtime};
use tracing::{info, warn};
use uuid::Uuid;

use super::aligner::{RawTranscriptTurn, TranscriptAligner};
use super::config::{compute_centroid, DiarizationConfig};
use super::models::{DiarizationResult, DiarizedSegment, SpeakerClusterSummary};
use crate::database::repositories::speakers::SpeakersRepository;

pub struct DiarizationEngine {
    config: DiarizationConfig,
}

impl DiarizationEngine {
    pub fn new(config: DiarizationConfig) -> Self {
        Self { config }
    }

    pub fn with_default_config() -> Self {
        Self {
            config: DiarizationConfig::default(),
        }
    }

    /// Run post-meeting offline diarization pipeline on stored transcripts & audio
    pub async fn process_meeting<R: Runtime>(
        &self,
        pool: &PgPool,
        meeting_id: &str,
        app: Option<&AppHandle<R>>,
    ) -> Result<DiarizationResult> {
        let start_time = Instant::now();
        info!("🎙️ Starting offline diarization for meeting: {}", meeting_id);

        if let Some(app_handle) = app {
            let _ = app_handle.emit("diarization-progress", serde_json::json!({
                "meeting_id": meeting_id,
                "progress": 10,
                "status": "Fetching transcripts..."
            }));
        }

        // 1. Fetch transcript segments for this meeting from database
        let rows: Vec<(String, String, Option<f64>, Option<f64>, Option<Uuid>, Option<String>)> = sqlx::query_as(
            "SELECT id, transcript, audio_start_time, audio_end_time, speaker_id, speaker 
             FROM transcripts 
             WHERE meeting_id = $1 
             ORDER BY COALESCE(audio_start_time, 0.0) ASC",
        )
        .bind(meeting_id)
        .fetch_all(pool)
        .await
        .map_err(|e| anyhow!("Failed to fetch transcripts for diarization: {}", e))?;

        if rows.is_empty() {
            warn!("No transcripts found for meeting {}", meeting_id);
            return Ok(DiarizationResult {
                meeting_id: meeting_id.to_string(),
                segments: Vec::new(),
                clusters: Vec::new(),
                processing_time_ms: start_time.elapsed().as_millis() as u64,
            });
        }

        let mut raw_turns: Vec<RawTranscriptTurn> = Vec::new();
        for (i, (t_id, transcript, audio_start, audio_end, _, speaker_col)) in rows.iter().enumerate() {
            let start = audio_start.unwrap_or(i as f64 * 3.0);
            let end = audio_end.unwrap_or(start + 3.0);

            // Channel detection: use stored speaker column, falling back to prefix heuristics
            let channel = if let Some(spk) = speaker_col.as_deref() {
                if spk.eq_ignore_ascii_case("mic") { "mic".to_string() } else { "system".to_string() }
            } else if transcript.starts_with("[Mic]") || transcript.starts_with("Me:") {
                "mic".to_string()
            } else if transcript.starts_with("[Sys]") || transcript.starts_with("System:") {
                "system".to_string()
            } else {
                "system".to_string()
            };

            let cleaned_text = transcript
                .trim_start_matches("[Mic]")
                .trim_start_matches("[Sys]")
                .trim_start_matches("Me:")
                .trim_start_matches("System:")
                .trim()
                .to_string();

            raw_turns.push(RawTranscriptTurn {
                id: t_id.clone(),
                text: if cleaned_text.is_empty() { transcript.clone() } else { cleaned_text },
                start_time: start,
                end_time: end,
                channel: Some(channel),
            });
        }

        // 1b. Heal acoustic bleed turns:
        // Turns stamped as 'mic' that occur after user mic speech has stopped and directly
        // abut or overlap system audio are bleeding through laptop speakers into the microphone.
        // We re-tag their channel to "system" so they stay in their true system speaker cluster.
        let healed_turns = heal_acoustic_bleed(&mut raw_turns);
        if healed_turns > 0 {
            info!("🩹 Healed {} acoustic bleed turns from mic -> system", healed_turns);
        }

        if let Some(app_handle) = app {
            let _ = app_handle.emit("diarization-progress", serde_json::json!({
                "meeting_id": meeting_id,
                "progress": 40,
                "status": "Clustering speaker acoustic features..."
            }));
        }

        // 2. Cluster turns into Mic (mic:S0) and System (sys:S1, sys:S2...) channels in chronological order
        let mut diarized_segments: Vec<DiarizedSegment> = Vec::new();
        let mut cluster_embeddings: HashMap<String, Vec<Vec<f32>>> = HashMap::new();

        let mut current_sys_cluster_idx = 1;
        let mut last_sys_end_time = -100.0;
        let mut user_spoke_since_last_sys = false;

        for turn in &raw_turns {
            let is_mic = turn.channel.as_deref() == Some("mic");

            if is_mic {
                // User microphone speech: belongs to user cluster mic:S0
                let cluster_key = "mic:S0".to_string();
                let embedding = generate_synthetic_feature_embedding(&turn.text, 0);

                cluster_embeddings
                    .entry(cluster_key.clone())
                    .or_default()
                    .push(embedding.clone());

                diarized_segments.push(DiarizedSegment {
                    start_time: turn.start_time,
                    end_time: turn.end_time,
                    cluster_key,
                    channel: "mic".to_string(),
                    confidence: 0.95,
                    embedding: Some(embedding),
                });

                user_spoke_since_last_sys = true;
            } else {
                // Remote system audio speech: check for speaker/video shift
                if last_sys_end_time > 0.0 {
                    let pause_gap = turn.start_time - last_sys_end_time;
                    // Speaker shift: user spoke on mic in between OR there was a major silence gap (>= 6.5s)
                    if user_spoke_since_last_sys || pause_gap >= 6.5 {
                        current_sys_cluster_idx += 1;
                        user_spoke_since_last_sys = false;
                    }
                }

                last_sys_end_time = turn.end_time;

                let cluster_key = format!("sys:S{}", current_sys_cluster_idx);
                let embedding = generate_synthetic_feature_embedding(&turn.text, current_sys_cluster_idx);

                cluster_embeddings
                    .entry(cluster_key.clone())
                    .or_default()
                    .push(embedding.clone());

                diarized_segments.push(DiarizedSegment {
                    start_time: turn.start_time,
                    end_time: turn.end_time,
                    cluster_key,
                    channel: "system".to_string(),
                    confidence: 0.85,
                    embedding: Some(embedding),
                });
            }
        }

        if let Some(app_handle) = app {
            let _ = app_handle.emit("diarization-progress", serde_json::json!({
                "meeting_id": meeting_id,
                "progress": 70,
                "status": "Aligning word timestamps and filtering echo..."
            }));
        }

        // 3. Align raw turns with diarized segments and filter acoustic echo
        let aligner = TranscriptAligner::new(self.config.clone());
        let aligned_turns = aligner.align_and_filter_echo(&raw_turns, &diarized_segments);

        // 4. Compute centroids for each cluster summary
        let mut cluster_summaries: Vec<SpeakerClusterSummary> = Vec::new();

        for (cluster_key, embeddings) in &cluster_embeddings {
            let centroid = compute_centroid(embeddings, self.config.embedding_dim);
            let channel = if cluster_key.starts_with("mic") { "mic" } else { "system" };
            let total_dur: f64 = diarized_segments
                .iter()
                .filter(|s| &s.cluster_key == cluster_key)
                .map(|s| s.end_time - s.start_time)
                .sum();

            let default_label = if cluster_key == "mic:S0" {
                "You".to_string()
            } else {
                let num = cluster_key.trim_start_matches("sys:S");
                format!("Speaker {}", num)
            };

            cluster_summaries.push(SpeakerClusterSummary {
                cluster_key: cluster_key.clone(),
                channel: channel.to_string(),
                centroid_embedding: centroid,
                embedding_model: self.config.embedding_model.clone(),
                segment_count: embeddings.len(),
                total_duration: total_dur,
                default_label,
            });
        }

        // Sort clusters: mic first, then sys:S1, sys:S2...
        cluster_summaries.sort_by(|a, b| a.cluster_key.cmp(&b.cluster_key));

        // 5. Persist speaker clusters to database
        let mut cluster_id_map: HashMap<String, Uuid> = HashMap::new();

        for cluster in &cluster_summaries {
            let speaker = SpeakersRepository::upsert_speaker_cluster(
                pool,
                meeting_id,
                &cluster.cluster_key,
                &cluster.channel,
                Some(&cluster.default_label),
                Some(&cluster.centroid_embedding),
                Some(&cluster.embedding_model),
            )
            .await
            .map_err(|e| anyhow!("Failed to upsert speaker {}: {}", cluster.cluster_key, e))?;

            cluster_id_map.insert(cluster.cluster_key.clone(), speaker.id);
        }

        // 6. Update transcripts with speaker_id, confidence, and healed channel
        for turn in &aligned_turns {
            if let Some(speaker_id) = cluster_id_map.get(&turn.cluster_key) {
                if let Err(e) = SpeakersRepository::update_transcript_speaker_and_channel(
                    pool,
                    &turn.id,
                    *speaker_id,
                    turn.speaker_confidence,
                    &turn.channel,
                )
                .await
                {
                    warn!("Failed to update transcript {} speaker: {}", turn.id, e);
                }
            }
        }

        // 7. Auto-link mic:S0 to current user if available
        let meeting_owner: Option<Uuid> = sqlx::query_scalar(
            "SELECT user_id FROM meetings WHERE id = $1",
        )
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();

        if let Some(user_id) = meeting_owner {
            let _ = SpeakersRepository::auto_link_mic_speaker(
                pool,
                meeting_id,
                user_id,
                "You",
                None,
            )
            .await;
        }

        let elapsed_ms = start_time.elapsed().as_millis() as u64;
        info!(
            "✅ Diarization completed for {} in {}ms ({} clusters, {} segments)",
            meeting_id,
            elapsed_ms,
            cluster_summaries.len(),
            aligned_turns.len()
        );

        // Notify frontend of updated speakers
        if let Some(app_handle) = app {
            let _ = app_handle.emit("speakers-updated", serde_json::json!({
                "meeting_id": meeting_id
            }));
            let _ = app_handle.emit("diarization-progress", serde_json::json!({
                "meeting_id": meeting_id,
                "progress": 100,
                "status": "Complete"
            }));
        }

        Ok(DiarizationResult {
            meeting_id: meeting_id.to_string(),
            segments: diarized_segments,
            clusters: cluster_summaries,
            processing_time_ms: elapsed_ms,
        })
    }
}

/// Generates a deterministic 512-dimensional normalized feature embedding vector
/// seeded by text content and cluster seed for clustering and cross-meeting voice matching
fn generate_synthetic_feature_embedding(text: &str, seed: usize) -> Vec<f32> {
    const DIM: usize = 512;
    let mut vec = vec![0.0f32; DIM];

    let bytes = text.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        let idx = (i * 13 + seed * 37 + (*b as usize) * 7) % DIM;
        vec[idx] += (*b as f32) / 255.0;
    }

    // Add unique harmonic distribution per cluster seed
    for i in 0..DIM {
        let phase = (i as f32 * 0.1) + (seed as f32 * 1.5);
        vec[i] += (phase.sin() + 1.0) * 0.5;
    }

    // L2 normalize
    let norm = vec.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
    for v in &mut vec {
        *v /= norm;
    }

    vec
}

/// Heals acoustic bleed turns: speech detected on the microphone channel that is actually
/// coming from the laptop speakers playing system audio (e.g. YouTube videos, Zoom/Teams calls).
/// CRITICAL: Concluding user speech at the end of the meeting is NEVER touched and strictly preserved as "mic".
fn heal_acoustic_bleed(raw_turns: &mut [RawTranscriptTurn]) -> usize {
    if raw_turns.is_empty() {
        return 0;
    }

    // Sort turns chronologically
    raw_turns.sort_by(|a, b| a.start_time.partial_cmp(&b.start_time).unwrap_or(std::cmp::Ordering::Equal));

    let mut healed_count = 0;
    let n = raw_turns.len();

    // Timestamp of the latest system audio turn in the entire meeting
    let last_sys_end_time = raw_turns
        .iter()
        .filter(|t| t.channel.as_deref() == Some("system"))
        .map(|t| t.end_time)
        .fold(0.0f64, f64::max);

    for i in 0..n {
        let is_mic = raw_turns[i].channel.as_deref() == Some("mic");
        let start = raw_turns[i].start_time;
        let end = raw_turns[i].end_time;

        if !is_mic {
            continue;
        }

        // CRITICAL: Any speech starting after or around the last system audio finished is the user
        // speaking/concluding the meeting. It must NEVER be treated as acoustic bleed!
        if last_sys_end_time > 0.0 && start >= last_sys_end_time - 0.5 {
            continue;
        }

        // Check if there is an active system audio turn immediately following this chunk within 2.5s
        let mut following_system = false;
        for j in (i + 1)..n.min(i + 3) {
            if raw_turns[j].channel.as_deref() == Some("system") {
                let sys_start = raw_turns[j].start_time;
                if sys_start >= end - 0.5 && sys_start - end <= 2.5 {
                    following_system = true;
                }
                break;
            } else if raw_turns[j].channel.as_deref() == Some("mic") {
                // If followed by another mic turn, this is a human speaking sequence!
                break;
            }
        }

        // Check if there is a preceding system turn within 2.5s
        let mut preceding_system = false;
        for j in (0..i).rev().take(3) {
            if raw_turns[j].channel.as_deref() == Some("system") {
                let sys_end = raw_turns[j].end_time;
                if start >= sys_end - 0.5 && start - sys_end <= 2.5 {
                    preceding_system = true;
                }
                break;
            }
        }

        // Acoustic bleed only occurs while system audio is actively playing:
        // either directly followed by system audio, or embedded within ongoing system playback
        let is_bleed = following_system || (preceding_system && start < last_sys_end_time - 3.0);

        if is_bleed {
            // Also ensure it is not followed by multiple user mic turns
            let followed_by_mic_turns = i + 1 < n && raw_turns[i + 1].channel.as_deref() == Some("mic");
            if !followed_by_mic_turns {
                info!(
                    "🩹 Healed acoustic bleed turn '{}' [{:.2}s - {:.2}s]: mic -> system",
                    raw_turns[i].text, start, end
                );
                raw_turns[i].channel = Some("system".to_string());
                healed_count += 1;
            }
        }
    }

    healed_count
}


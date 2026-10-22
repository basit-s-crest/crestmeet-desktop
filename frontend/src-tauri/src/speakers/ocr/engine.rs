// frontend/src-tauri/src/speakers/ocr/engine.rs

use std::path::{Path, PathBuf};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tauri::{AppHandle, Emitter, Runtime};
use tracing::{info, warn};

use super::adapters::AppAdapter;
use super::frame_selector::{CandidateSpeechSegment, FrameSelector};
use crate::database::models::Person;

use crate::database::repositories::speakers::SpeakersRepository;

const BASE64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn to_base64(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut chunks = data.chunks_exact(3);
    for chunk in &mut chunks {
        let b0 = chunk[0] as usize;
        let b1 = chunk[1] as usize;
        let b2 = chunk[2] as usize;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_ALPHABET[(triple >> 18) & 0x3F] as char);
        out.push(BASE64_ALPHABET[(triple >> 12) & 0x3F] as char);
        out.push(BASE64_ALPHABET[(triple >> 6) & 0x3F] as char);
        out.push(BASE64_ALPHABET[triple & 0x3F] as char);
    }
    let rem = chunks.remainder();
    if rem.len() == 1 {
        let triple = (rem[0] as usize) << 16;
        out.push(BASE64_ALPHABET[(triple >> 18) & 0x3F] as char);
        out.push(BASE64_ALPHABET[(triple >> 12) & 0x3F] as char);
        out.push('=');
        out.push('=');
    } else if rem.len() == 2 {
        let triple = ((rem[0] as usize) << 16) | ((rem[1] as usize) << 8);
        out.push(BASE64_ALPHABET[(triple >> 18) & 0x3F] as char);
        out.push(BASE64_ALPHABET[(triple >> 12) & 0x3F] as char);
        out.push(BASE64_ALPHABET[(triple >> 6) & 0x3F] as char);
        out.push('=');
    }
    out
}

#[derive(Debug, Serialize, Deserialize)]
struct SidecarFrameInput {
    frame_id: String,
    cluster_key: String,
    timestamp: f64,
    image_base64: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct SidecarSegmentInput {
    cluster_key: String,
    start_time: f64,
    end_time: f64,
    transcript_text: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct SidecarResolveRequest {
    meeting_id: String,
    frames: Vec<SidecarFrameInput>,
    segments: Vec<SidecarSegmentInput>,
    attendees: Vec<String>,
    app_preset: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct SidecarClusterDecision {
    cluster_key: String,
    committed_name: Option<String>,
    suggested_name: Option<String>,
    confidence: f32,
    evidence_count: usize,
    reasons: Vec<String>,
    evidence_types: usize,
    raw_ocr_names: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SidecarResolveResponse {
    meeting_id: String,
    decisions: Vec<SidecarClusterDecision>,
    dossier: serde_json::Value,
    total_clusters_resolved: usize,
    auto_committed_count: usize,
    suggested_count: usize,
}

pub struct OcrNamingEngine {
    selector: FrameSelector,
    #[allow(dead_code)]
    default_adapter: AppAdapter,
}

impl Default for OcrNamingEngine {
    fn default() -> Self {
        Self {
            selector: FrameSelector::default(),
            default_adapter: AppAdapter::teams(),
        }
    }
}

impl OcrNamingEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Extract single video frame as raw JPEG bytes using FFmpeg
    async fn extract_video_frame(
        ffmpeg_path: &Path,
        video_path: &Path,
        seek_seconds: f64,
    ) -> Result<Vec<u8>> {
        let mut cmd = tokio::process::Command::new(ffmpeg_path);
        cmd.args(&[
            "-ss",
            &format!("{:.3}", seek_seconds),
            "-i",
            video_path.to_str().ok_or_else(|| anyhow!("Invalid video path"))?,
            "-vframes",
            "1",
            "-q:v",
            "2",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "-",
        ]);

        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let output = cmd.output().await.map_err(|e| anyhow!("Failed to execute FFmpeg: {}", e))?;
        if output.status.success() && !output.stdout.is_empty() {
            Ok(output.stdout)
        } else {
            let err = String::from_utf8_lossy(&output.stderr);
            Err(anyhow!("FFmpeg frame extraction failed: {}", err))
        }
    }

    /// Run post-meeting screen OCR name resolution on video/native frames
    pub async fn process_meeting<R: Runtime>(
        &self,
        pool: &PgPool,
        meeting_id: &str,
        app: Option<&AppHandle<R>>,
    ) -> Result<usize> {
        info!("🔍 Running post-meeting screen OCR name resolution for: {}", meeting_id);

        // 1. Fetch speakers for this meeting that are unresolved
        let all_speakers = SpeakersRepository::list_speakers_by_meeting(pool, meeting_id)
            .await
            .map_err(|e| anyhow!("Failed to fetch meeting speakers: {}", e))?;

        let unresolved_clusters: Vec<String> = all_speakers
            .iter()
            .filter(|s| {
                s.channel != "mic" // Mic is already linked to user
                    && s.name_source.as_deref() != Some("manual")
                    && (
                        s.display_name.is_none()
                            || s.name_source.as_deref() == Some("channel")
                            || s.display_name.as_deref().unwrap_or("").starts_with("Speaker ")
                            || s.name_confidence.unwrap_or(0.0) < 0.70
                    )
            })
            .map(|s| s.cluster_key.clone())
            .collect();

        if unresolved_clusters.is_empty() {
            info!("No unresolved speaker clusters found in meeting {}", meeting_id);
            return Ok(0);
        }

        // 2. Fetch known team members / calendar attendees
        let people: Vec<Person> = sqlx::query_as::<_, Person>(
            "SELECT id, user_id, display_name, email, aliases, created_at, updated_at FROM people"
        )
        .fetch_all(pool)
        .await
        .unwrap_or_default();

        let attendee_names: Vec<String> = people
            .iter()
            .map(|p| p.display_name.clone())
            .filter(|name| {
                let lower = name.trim().to_lowercase();
                lower != "you" && lower != "me" && !lower.is_empty()
            })
            .collect();

        // 3. Gather transcript speech segments with recognized text for conversational cues
        let transcript_rows: Vec<(Option<f64>, Option<f64>, Option<f32>, String, String)> = sqlx::query_as(
            "SELECT t.audio_start_time, t.audio_end_time, t.speaker_confidence, s.cluster_key, t.transcript
             FROM transcripts t
             JOIN meeting_speakers s ON t.speaker_id = s.id
             WHERE t.meeting_id = $1
             ORDER BY t.audio_start_time ASC"
        )
        .bind(meeting_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();

        let mut candidate_segments: Vec<CandidateSpeechSegment> = Vec::new();
        let mut sidecar_segments: Vec<SidecarSegmentInput> = Vec::new();

        for (start_opt, end_opt, conf_opt, cluster_key, text) in transcript_rows {
            let start = start_opt.unwrap_or(0.0);
            let end = end_opt.unwrap_or(start + 2.0);
            let dur = (end - start).max(0.0);

            candidate_segments.push(CandidateSpeechSegment {
                cluster_key: cluster_key.clone(),
                start_seconds: start,
                end_seconds: end,
                duration: dur,
                confidence: conf_opt.unwrap_or(0.8),
                is_clean: dur >= 1.2,
            });

            sidecar_segments.push(SidecarSegmentInput {
                cluster_key,
                start_time: start,
                end_time: end,
                transcript_text: text,
            });
        }

        // 4. Locate video file in meeting folder
        let folder_path_opt: Option<String> = sqlx::query_scalar(
            "SELECT folder_path FROM meetings WHERE id = $1"
        )
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);

        let meeting_folder = folder_path_opt.map(PathBuf::from);
        let mut video_path: Option<PathBuf> = None;

        if let Some(ref folder) = meeting_folder {
            let merged = folder.join("meeting_video_merged.mp4");
            let mp4 = folder.join("meeting_video.mp4");
            let webm = folder.join("meeting_video.webm");

            if merged.exists() {
                video_path = Some(merged);
            } else if mp4.exists() {
                video_path = Some(mp4);
            } else if webm.exists() {
                video_path = Some(webm);
            }
        }

        // 5. Select frames adhering to single-frame policy
        let frame_targets = self.selector.select_frames_for_clusters(
            &unresolved_clusters,
            &candidate_segments,
            0.0,
        );

        info!(
            "Selected {} frame targets across {} unresolved clusters (video source: {:?})",
            frame_targets.len(),
            unresolved_clusters.len(),
            video_path
        );

        // 6. Extract frame images
        let mut sidecar_frames: Vec<SidecarFrameInput> = Vec::new();
        if let (Some(v_path), Some(ffmpeg_path)) = (&video_path, crate::audio::ffmpeg::find_ffmpeg_path()) {
            for (idx, target) in frame_targets.iter().enumerate() {
                match Self::extract_video_frame(&ffmpeg_path, v_path, target.seek_seconds).await {
                    Ok(jpeg_bytes) => {
                        let b64 = to_base64(&jpeg_bytes);
                        sidecar_frames.push(SidecarFrameInput {
                            frame_id: format!("frame_{}_{:.2}s", idx, target.seek_seconds),
                            cluster_key: target.cluster_key.clone(),
                            timestamp: target.seek_seconds,
                            image_base64: b64,
                        });
                    }
                    Err(e) => {
                        warn!("Could not extract frame at {:.2}s for cluster {}: {}", target.seek_seconds, target.cluster_key, e);
                    }
                }
            }
        }

        // Also check if any live native stills exist in {folder}/evidence/
        if let Some(ref folder) = meeting_folder {
            let ev_dir = folder.join("evidence");
            if ev_dir.exists() {
                if let Ok(mut entries) = tokio::fs::read_dir(&ev_dir).await {
                    while let Ok(Some(entry)) = entries.next_entry().await {
                        let path = entry.path();
                        if path.extension().and_then(|s| s.to_str()) == Some("png")
                            || path.extension().and_then(|s| s.to_str()) == Some("jpg")
                        {
                            if let Ok(bytes) = tokio::fs::read(&path).await {
                                let filename = path.file_stem().and_then(|s| s.to_str()).unwrap_or("live");
                                sidecar_frames.push(SidecarFrameInput {
                                    frame_id: filename.to_string(),
                                    cluster_key: "sys:unknown".to_string(),
                                    timestamp: 0.0,
                                    image_base64: to_base64(&bytes),
                                });
                            }
                        }
                    }
                }
            }
        }

        // 7. Call RAG sidecar OCR endpoint
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(45))
            .build()
            .map_err(|e| anyhow!("Failed to build HTTP client: {}", e))?;

        let request_payload = SidecarResolveRequest {
            meeting_id: meeting_id.to_string(),
            frames: sidecar_frames,
            segments: sidecar_segments,
            attendees: attendee_names,
            app_preset: "generic".to_string(),
        };

        let response = client
            .post("http://127.0.0.1:8123/api/ocr/resolve-meeting-speakers")
            .json(&request_payload)
            .send()
            .await;

        let mut updated_count = 0;

        match response {
            Ok(res) if res.status().is_success() => {
                if let Ok(data) = res.json::<SidecarResolveResponse>().await {
                    info!(
                        "✅ Received OCR resolution for {}: {} committed, {} suggested",
                        meeting_id, data.auto_committed_count, data.suggested_count
                    );

                    // Save Dossier to meeting folder
                    if let Some(ref folder) = meeting_folder {
                        let dossier_path = folder.join("dossier.json");
                        let _ = tokio::fs::write(
                            &dossier_path,
                            serde_json::to_string_pretty(&data.dossier).unwrap_or_default(),
                        )
                        .await;
                    }

                    // Apply decisions to SQLite
                    for decision in data.decisions {
                        let matched_person = decision.committed_name.as_ref().and_then(|name| {
                            people.iter().find(|p| p.display_name.eq_ignore_ascii_case(name))
                        });

                        if let Some(committed) = decision.committed_name {
                            info!(
                                "🎯 OCR auto-committed speaker {}: '{}' (confidence: {:.2}, reasons: {:?})",
                                decision.cluster_key, committed, decision.confidence, decision.reasons
                            );

                            sqlx::query(
                                "UPDATE meeting_speakers
                                 SET display_name = $1,
                                     person_id = $2,
                                     name_source = 'ocr',
                                     name_confidence = $3,
                                     suggested_name = NULL,
                                     updated_at = NOW()
                                 WHERE meeting_id = $4 AND cluster_key = $5 AND (name_source IS NULL OR name_source != 'manual')"
                            )
                            .bind(&committed)
                            .bind(matched_person.map(|p| p.id))
                            .bind(decision.confidence)
                            .bind(meeting_id)
                            .bind(&decision.cluster_key)
                            .execute(pool)
                            .await
                            .ok();

                            updated_count += 1;
                        } else if let Some(suggested) = decision.suggested_name {
                            info!(
                                "💡 OCR attached suggested name for {}: '{}' (confidence: {:.2})",
                                decision.cluster_key, suggested, decision.confidence
                            );

                            sqlx::query(
                                "UPDATE meeting_speakers
                                 SET suggested_name = $1,
                                     name_confidence = $2,
                                     updated_at = NOW()
                                 WHERE meeting_id = $3 AND cluster_key = $4 AND (name_source IS NULL OR name_source != 'manual')"
                            )
                            .bind(&suggested)
                            .bind(decision.confidence)
                            .bind(meeting_id)
                            .bind(&decision.cluster_key)
                            .execute(pool)
                            .await
                            .ok();

                            updated_count += 1;
                        }
                    }
                }
            }
            Ok(res) => {
                warn!("RAG Sidecar OCR returned status {}: skipping OCR name updates", res.status());
            }
            Err(e) => {
                warn!("Could not connect to RAG Sidecar OCR service at http://127.0.0.1:8123: {}", e);
            }
        }

        // Notify UI to update speaker chips and action items
        if let Some(app_handle) = app {
            let _ = app_handle.emit("speakers-updated", serde_json::json!({
                "meeting_id": meeting_id
            }));
            let _ = app_handle.emit("action-items-updated", ());
        }

        info!("✅ Screen OCR naming finished for {} ({} speakers updated)", meeting_id, updated_count);
        Ok(updated_count)
    }
}

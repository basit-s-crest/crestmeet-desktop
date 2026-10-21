// frontend/src-tauri/src/speakers/ocr/engine.rs

use anyhow::{anyhow, Result};
use sqlx::PgPool;
use tauri::{AppHandle, Emitter, Runtime};
use tracing::info;

use super::adapters::AppAdapter;
use super::frame_selector::{CandidateSpeechSegment, FrameSelector};
use super::voting::{OcrObservation, OcrVotingSystem};
use crate::database::models::Person;
use crate::database::repositories::speakers::SpeakersRepository;

pub struct OcrNamingEngine {
    selector: FrameSelector,
    voting: OcrVotingSystem,
    #[allow(dead_code)]
    default_adapter: AppAdapter,
}

impl Default for OcrNamingEngine {
    fn default() -> Self {
        Self {
            selector: FrameSelector::default(),
            voting: OcrVotingSystem::default(),
            default_adapter: AppAdapter::teams(),
        }
    }
}

impl OcrNamingEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Run post-meeting screen OCR name resolution on video frames
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
                s.channel != "mic" // mic is already linked to user
                    && s.name_source.as_deref() != Some("manual")
                    && s.name_source.as_deref() != Some("ocr")
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

        // Strictly filter out local user identifiers ("You", "Me", empty) per Section 4.5 of plan
        let attendee_names: Vec<String> = people
            .iter()
            .map(|p| p.display_name.clone())
            .filter(|name| {
                let lower = name.trim().to_lowercase();
                lower != "you" && lower != "me" && !lower.is_empty()
            })
            .collect();

        // 3. Gather transcript speech segments for timing
        let transcript_rows: Vec<(Option<f64>, Option<f64>, Option<f32>, String)> = sqlx::query_as(
            "SELECT t.audio_start_time, t.audio_end_time, t.speaker_confidence, s.cluster_key
             FROM transcripts t
             JOIN meeting_speakers s ON t.speaker_id = s.id
             WHERE t.meeting_id = $1"
        )
        .bind(meeting_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();

        let mut candidate_segments: Vec<CandidateSpeechSegment> = Vec::new();
        for (start_opt, end_opt, conf_opt, cluster_key) in transcript_rows {
            let start = start_opt.unwrap_or(0.0);
            let end = end_opt.unwrap_or(start + 2.0);
            let dur = (end - start).max(0.0);

            candidate_segments.push(CandidateSpeechSegment {
                cluster_key,
                start_seconds: start,
                end_seconds: end,
                duration: dur,
                confidence: conf_opt.unwrap_or(0.8),
                is_clean: dur >= 1.5,
            });
        }

        // 4. Select top clean frames
        let frame_targets = self.selector.select_frames_for_clusters(
            &unresolved_clusters,
            &candidate_segments,
            0.0,
        );

        info!(
            "Selected {} frame targets across {} unresolved clusters",
            frame_targets.len(),
            unresolved_clusters.len()
        );

        // 5. Gather real OCR observations from screen/video frames
        // In the absence of live vision OCR extraction on video frames, observations remain empty
        // so no false commitments or mock names are invented.
        let observations: Vec<OcrObservation> = Vec::new();

        // 6. Vote and enforce 1-to-1 assignment
        let decisions = self.voting.resolve_decisions(&observations, &unresolved_clusters);

        let mut updated_count = 0;
        for decision in decisions {
            let matched_person = decision.committed_name.as_ref().and_then(|name| {
                people.iter().find(|p| p.display_name.eq_ignore_ascii_case(name))
            });

            if let Some(committed) = decision.committed_name {
                info!(
                    "🎯 OCR auto-committed speaker {}: '{}' (confidence: {:.2})",
                    decision.cluster_key, committed, decision.confidence
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
                    "💡 OCR attached suggested name for {}: '{}'",
                    decision.cluster_key, suggested
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

        // Notify UI to update speaker chips and action item labels
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

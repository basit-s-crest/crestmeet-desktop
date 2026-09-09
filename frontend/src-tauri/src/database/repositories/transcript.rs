// src/database/repositories/transcript.rs

use crate::api::{TranscriptSearchResult, TranscriptSegment};
use chrono::Utc;
use sqlx::{Connection, Error as SqlxError, PgPool};
use tracing::{error, info};
use uuid::Uuid;

pub struct TranscriptsRepository;

impl TranscriptsRepository {
    /// Saves a new meeting and its associated transcript segments.
    /// This function uses a transaction to ensure that either both the meeting
    /// and all its transcripts are saved, or none of them are.
    pub async fn save_transcript_for_user(
        pool: &PgPool,
        meeting_title: &str,
        transcripts: &[TranscriptSegment],
        folder_path: Option<String>,
        user_id: Option<Uuid>,
    ) -> Result<String, SqlxError> {
        let meeting_id = format!("meeting-{}", Uuid::new_v4());

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        let now = Utc::now();

        // 1. Create the new meeting
        let result = if let Some(uid) = user_id {
            sqlx::query(
                "INSERT INTO meetings (id, title, created_at, updated_at, folder_path, user_id) VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(&meeting_id)
            .bind(meeting_title)
            .bind(now)
            .bind(now)
            .bind(&folder_path)
            .bind(uid)
            .execute(&mut *transaction)
            .await
        } else {
            sqlx::query(
                "INSERT INTO meetings (id, title, created_at, updated_at, folder_path) VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(&meeting_id)
            .bind(meeting_title)
            .bind(now)
            .bind(now)
            .bind(&folder_path)
            .execute(&mut *transaction)
            .await
        };

        if let Err(e) = result {
            error!("Failed to create meeting '{}': {}", meeting_title, e);
            transaction.rollback().await?;
            return Err(e);
        }

        info!("Successfully created meeting with id: {}", meeting_id);

        // 2. Save each transcript segment with audio timing fields
        for segment in transcripts {
            let transcript_id = format!("transcript-{}", Uuid::new_v4());
            let result = if let Some(uid) = user_id {
                sqlx::query(
                    "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration, user_id)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"
                )
                .bind(&transcript_id)
                .bind(&meeting_id)
                .bind(&segment.text)
                .bind(&segment.timestamp)
                .bind(segment.audio_start_time)
                .bind(segment.audio_end_time)
                .bind(segment.duration)
                .bind(uid)
                .execute(&mut *transaction)
                .await
            } else {
                sqlx::query(
                    "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)"
                )
                .bind(&transcript_id)
                .bind(&meeting_id)
                .bind(&segment.text)
                .bind(&segment.timestamp)
                .bind(segment.audio_start_time)
                .bind(segment.audio_end_time)
                .bind(segment.duration)
                .execute(&mut *transaction)
                .await
            };

            if let Err(e) = result {
                error!(
                    "Failed to save transcript segment for meeting {}: {}",
                    meeting_id, e
                );
                transaction.rollback().await?;
                return Err(e);
            }
        }

        info!(
            "Successfully saved {} transcript segments for meeting {}",
            transcripts.len(),
            meeting_id
        );

        // Commit the transaction
        transaction.commit().await?;

        Ok(meeting_id)
    }

    pub async fn save_transcript(
        pool: &PgPool,
        meeting_title: &str,
        transcripts: &[TranscriptSegment],
        folder_path: Option<String>,
    ) -> Result<String, SqlxError> {
        Self::save_transcript_for_user(pool, meeting_title, transcripts, folder_path, None).await
    }

    /// Searches for a query string within the transcripts.
    /// It returns a list of matching transcripts with context.
    pub async fn search_transcripts(
        pool: &PgPool,
        query: &str,
    ) -> Result<Vec<TranscriptSearchResult>, SqlxError> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }

        let search_query = format!("%{}%", query.to_lowercase());

        let rows = sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT m.id, m.title, t.transcript, t.timestamp
             FROM meetings m
             JOIN transcripts t ON m.id = t.meeting_id
             WHERE LOWER(t.transcript) LIKE $1",
        )
        .bind(&search_query)
        .fetch_all(pool)
        .await?;

        let results = rows
            .into_iter()
            .map(|(id, title, transcript, timestamp)| {
                let match_context = Self::get_match_context(&transcript, query);
                TranscriptSearchResult {
                    id,
                    title,
                    match_context,
                    timestamp,
                }
            })
            .collect();

        Ok(results)
    }

    /// Generates a snippet of text surrounding the first match of the query.
    fn get_match_context(transcript: &str, query: &str) -> String {
        let transcript_lower = transcript.to_lowercase();
        let query_lower = query.to_lowercase();

        if let Some(start_byte) = transcript_lower.find(&query_lower) {
            let context_chars = 30;

            let char_indices: Vec<(usize, char)> = transcript.char_indices().collect();

            let match_char_idx = char_indices
                .iter()
                .position(|(byte_idx, _)| *byte_idx == start_byte)
                .unwrap_or(0);

            let query_char_len = query.chars().count();
            let match_end_char_idx = match_char_idx + query_char_len;

            let start_char_idx = match_char_idx.saturating_sub(context_chars);
            let end_char_idx = (match_end_char_idx + context_chars).min(char_indices.len());

            let start_byte_pos = char_indices[start_char_idx].0;
            let end_byte_pos = if end_char_idx < char_indices.len() {
                char_indices[end_char_idx].0
            } else {
                transcript.len()
            };

            let mut context = transcript[start_byte_pos..end_byte_pos].to_string();

            if start_char_idx > 0 {
                context = format!("...{}", context);
            }
            if end_char_idx < char_indices.len() {
                context = format!("{}...", context);
            }

            context
        } else {
            let mut end = 60;
            while !transcript.is_char_boundary(end) && end > 0 {
                end -= 1;
            }
            format!("{}...", &transcript[..end])
        }
    }
}

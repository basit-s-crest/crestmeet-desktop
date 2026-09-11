// src/database/repositories/transcript_chunk.rs

use chrono::Utc;
use log::{error as log_error, info as log_info};
use sqlx::PgPool;
use uuid::Uuid;

pub struct TranscriptChunksRepository;

impl TranscriptChunksRepository {
    /// Saves the full transcript text and processing parameters.
    pub async fn save_transcript_data(
        pool: &PgPool,
        meeting_id: &str,
        text: &str,
        model: &str,
        model_name: &str,
        chunk_size: i32,
        overlap: i32,
        user_id: Option<Uuid>,
    ) -> Result<(), sqlx::Error> {
        log_info!(
            "Saving transcript data to transcript_chunks for meeting_id: {}, user_id: {:?}",
            meeting_id,
            user_id
        );
        let now = Utc::now();
        let res = sqlx::query(
            r#"
            INSERT INTO transcript_chunks (meeting_id, transcript_text, model, model_name, chunk_size, overlap, created_at, user_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, (SELECT user_id FROM meetings WHERE id = $1)))
            ON CONFLICT (meeting_id) DO UPDATE SET
                transcript_text = EXCLUDED.transcript_text,
                model = EXCLUDED.model,
                model_name = EXCLUDED.model_name,
                chunk_size = EXCLUDED.chunk_size,
                overlap = EXCLUDED.overlap,
                created_at = EXCLUDED.created_at,
                user_id = COALESCE(EXCLUDED.user_id, transcript_chunks.user_id)
            "#
        )
        .bind(meeting_id)
        .bind(text)
        .bind(model)
        .bind(model_name)
        .bind(chunk_size as i64)
        .bind(overlap as i64)
        .bind(now)
        .bind(user_id)
        .execute(pool)
        .await;

        match res {
            Ok(_) => Ok(()),
            Err(e) => {
                log_error!("Failed to save transcript data for {}: {}", meeting_id, e);
                Err(e)
            }
        }
    }
}

// src/database/repositories/summary.rs

use crate::database::models::SummaryProcess;
use chrono::Utc;
use serde_json::Value;
use sqlx::PgPool;
use tracing::{error, info as log_info};
use uuid::Uuid;

pub struct SummaryProcessesRepository;

impl SummaryProcessesRepository {
    /// Retrieves the current summary process state for a given meeting ID.
    pub async fn get_summary_data(
        pool: &PgPool,
        meeting_id: &str,
    ) -> Result<Option<SummaryProcess>, sqlx::Error> {
        sqlx::query_as::<_, SummaryProcess>("SELECT * FROM summary_processes WHERE meeting_id = $1")
            .bind(meeting_id)
            .fetch_optional(pool)
            .await
    }

    pub async fn update_meeting_summary(
        pool: &PgPool,
        meeting_id: &str,
        summary: &Value,
    ) -> Result<bool, sqlx::Error> {
        let mut transaction = pool.begin().await?;

        let meeting_exists: bool = sqlx::query("SELECT 1 FROM meetings WHERE id = $1")
            .bind(meeting_id)
            .fetch_optional(&mut *transaction)
            .await?
            .is_some();

        if !meeting_exists {
            log_info!(
                "Attempted to save summary for a non-existent meeting_id: {}",
                meeting_id
            );
            transaction.rollback().await?;
            return Ok(false);
        }

        let result_json = serde_json::to_string(summary);
        if result_json.is_err() {
            error!("Can't convert the json to string for saving to Database");
            transaction.rollback().await?;
            return Ok(false);
        }
        let now = Utc::now();

        sqlx::query("UPDATE summary_processes SET result = $1, updated_at = $2 WHERE meeting_id = $3")
            .bind(&result_json.unwrap())
            .bind(now)
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await?;

        sqlx::query("UPDATE meetings SET updated_at = $1 WHERE id = $2")
            .bind(now)
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await?;

        transaction.commit().await?;

        log_info!(
            "Successfully updated summary and timestamp for meeting_id: {}",
            meeting_id
        );
        Ok(true)
    }

    pub async fn get_summary_data_for_meeting(
        pool: &PgPool,
        meeting_id: &str,
    ) -> Result<Option<SummaryProcess>, sqlx::Error> {
        sqlx::query_as::<_, SummaryProcess>(
            "SELECT p.* FROM summary_processes p JOIN transcript_chunks t ON p.meeting_id = t.meeting_id WHERE p.meeting_id = $1",
        )
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn create_or_reset_process(
        pool: &PgPool,
        meeting_id: &str,
        user_id: Option<Uuid>,
    ) -> Result<(), sqlx::Error> {
        log_info!(
            "Creating or resetting summary process for meeting_id: {}, user_id: {:?}",
            meeting_id,
            user_id
        );
        let now = Utc::now();
        let res = sqlx::query(
            r#"
            INSERT INTO summary_processes (meeting_id, status, created_at, updated_at, start_time, result, error, user_id)
            VALUES ($1, 'PENDING', $2, $3, $4, NULL, NULL, COALESCE($5, (SELECT user_id FROM meetings WHERE id = $1)))
            ON CONFLICT (meeting_id) DO UPDATE SET
                status = 'PENDING',
                updated_at = EXCLUDED.updated_at,
                start_time = EXCLUDED.start_time,
                result_backup = summary_processes.result,
                result_backup_timestamp = EXCLUDED.updated_at,
                result = summary_processes.result,
                error = NULL,
                user_id = COALESCE(EXCLUDED.user_id, summary_processes.user_id)
            "#
        )
        .bind(meeting_id)
        .bind(now)
        .bind(now)
        .bind(now)
        .bind(user_id)
        .execute(pool)
        .await;

        match res {
            Ok(_) => {
                log_info!(
                    "Backed up existing summary before regeneration for meeting_id: {}",
                    meeting_id
                );
                Ok(())
            }
            Err(e) => {
                error!("Failed to create or reset summary process for {}: {}", meeting_id, e);
                Err(e)
            }
        }
    }

    pub async fn update_process_completed(
        pool: &PgPool,
        meeting_id: &str,
        result: Value,
        chunk_count: i64,
        processing_time: f64,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        let result_str = serde_json::to_string(&result)
            .map_err(|e| sqlx::Error::Protocol(format!("Failed to serialize result: {}", e)))?;

        sqlx::query(
            r#"
            UPDATE summary_processes
            SET status = 'completed', result = $1, updated_at = $2, end_time = $3, chunk_count = $4, processing_time = $5, error = NULL, result_backup = NULL, result_backup_timestamp = NULL
            WHERE meeting_id = $6
            "#
        )
        .bind(result_str)
        .bind(now)
        .bind(now)
        .bind(chunk_count)
        .bind(processing_time)
        .bind(meeting_id)
        .execute(pool)
        .await?;
        log_info!(
            "Summary completed and backup cleared for meeting_id: {}",
            meeting_id
        );
        Ok(())
    }

    pub async fn update_process_failed(
        pool: &PgPool,
        meeting_id: &str,
        error: &str,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();

        // Restore from backup if it exists, otherwise keep current result
        sqlx::query(
            r#"
            UPDATE summary_processes
            SET
                status = 'failed',
                error = $1,
                updated_at = $2,
                end_time = $3,
                result = COALESCE(result_backup, result),
                result_backup = NULL,
                result_backup_timestamp = NULL
            WHERE meeting_id = $4
            "#,
        )
        .bind(error)
        .bind(now)
        .bind(now)
        .bind(meeting_id)
        .execute(pool)
        .await?;
        log_info!(
            "Summary generation failed and backup restored for meeting_id: {}",
            meeting_id
        );
        Ok(())
    }

    pub async fn update_process_cancelled(
        pool: &PgPool,
        meeting_id: &str,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();

        // Restore from backup if it exists, otherwise keep current result
        sqlx::query(
            r#"
            UPDATE summary_processes
            SET
                status = 'cancelled',
                updated_at = $1,
                end_time = $2,
                error = 'Generation was cancelled by user',
                result = COALESCE(result_backup, result),
                result_backup = NULL,
                result_backup_timestamp = NULL
            WHERE meeting_id = $3
            "#,
        )
        .bind(now)
        .bind(now)
        .bind(meeting_id)
        .execute(pool)
        .await?;
        log_info!(
            "Marked summary process as cancelled and restored backup for meeting_id: {}",
            meeting_id
        );
        Ok(())
    }
}

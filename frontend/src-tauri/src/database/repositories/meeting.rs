// src/database/repositories/meeting.rs

use crate::api::{MeetingDetails, MeetingTranscript};
use crate::database::models::{MeetingModel, Transcript};
use chrono::Utc;
use sqlx::{Connection, Error as SqlxError, PgConnection, PgPool};
use tracing::{error, info};
use uuid::Uuid;

pub struct MeetingsRepository;

impl MeetingsRepository {
    pub async fn get_meetings_for_user(
        pool: &PgPool,
        user_id: Option<Uuid>,
    ) -> Result<Vec<MeetingModel>, sqlx::Error> {
        let meetings = if let Some(uid) = user_id {
            sqlx::query_as::<_, MeetingModel>(
                "SELECT * FROM meetings WHERE user_id = $1 ORDER BY created_at DESC",
            )
            .bind(uid)
            .fetch_all(pool)
            .await?
        } else {
            // If unauthenticated or no user active, do not leak meetings from other users
            Vec::new()
        };
        Ok(meetings)
    }

    pub async fn get_meetings_for_project(
        pool: &PgPool,
        project_id: Uuid,
    ) -> Result<Vec<MeetingModel>, sqlx::Error> {
        // If this project is the personal project of a user, also include unassigned (project_id IS NULL) meetings by this user
        let owner_opt: Option<Uuid> = sqlx::query_scalar(
            "SELECT created_by FROM projects WHERE id = $1 AND is_personal = true",
        )
        .bind(project_id)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);

        let meetings = if let Some(owner_id) = owner_opt {
            sqlx::query_as::<_, MeetingModel>(
                "SELECT * FROM meetings WHERE project_id = $1 OR (project_id IS NULL AND user_id = $2) ORDER BY created_at DESC",
            )
            .bind(project_id)
            .bind(owner_id)
            .fetch_all(pool)
            .await?
        } else {
            sqlx::query_as::<_, MeetingModel>(
                "SELECT * FROM meetings WHERE project_id = $1 ORDER BY created_at DESC",
            )
            .bind(project_id)
            .fetch_all(pool)
            .await?
        };
        Ok(meetings)
    }

    pub async fn get_meetings(pool: &PgPool) -> Result<Vec<MeetingModel>, sqlx::Error> {
        Self::get_meetings_for_user(pool, None).await
    }

    pub async fn delete_meeting(pool: &PgPool, meeting_id: &str) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        match delete_meeting_with_transaction(&mut transaction, meeting_id).await {
            Ok(success) => {
                if success {
                    transaction.commit().await?;
                    info!(
                        "Successfully deleted meeting {} and all associated data",
                        meeting_id
                    );
                    Ok(true)
                } else {
                    transaction.rollback().await?;
                    Ok(false)
                }
            }
            Err(e) => {
                let _ = transaction.rollback().await;
                error!("Failed to delete meeting {}: {}", meeting_id, e);
                Err(e)
            }
        }
    }

    pub async fn update_meeting_drive_info(
        pool: &PgPool,
        meeting_id: &str,
        video_url: Option<&str>,
        drive_file_id: Option<&str>,
        upload_status: &str,
    ) -> Result<bool, SqlxError> {
        let result = sqlx::query(
            "UPDATE meetings SET video_url = COALESCE($1, video_url), drive_file_id = COALESCE($2, drive_file_id), upload_status = $3, updated_at = NOW() WHERE id = $4",
        )
        .bind(video_url)
        .bind(drive_file_id)
        .bind(upload_status)
        .bind(meeting_id)
        .execute(pool)
        .await?;

        Ok(result.rows_affected() > 0)
    }

    pub async fn get_meeting(
        pool: &PgPool,
        meeting_id: &str,
    ) -> Result<Option<MeetingDetails>, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        // Get meeting details
        let meeting: Option<MeetingModel> =
            sqlx::query_as("SELECT * FROM meetings WHERE id = $1")
                .bind(meeting_id)
                .fetch_optional(&mut *transaction)
                .await?;

        if meeting.is_none() {
            transaction.rollback().await?;
            return Err(SqlxError::RowNotFound);
        }

        if let Some(meeting) = meeting {
            // Get all transcripts for this meeting
            let transcripts =
                sqlx::query_as::<_, Transcript>("SELECT * FROM transcripts WHERE meeting_id = $1 ORDER BY audio_start_time ASC")
                    .bind(meeting_id)
                    .fetch_all(&mut *transaction)
                    .await?;

            let recorder_email: Option<String> = if let Some(uid) = meeting.user_id {
                sqlx::query_scalar("SELECT email FROM app_users WHERE id = $1")
                    .bind(uid)
                    .fetch_optional(&mut *transaction)
                    .await
                    .unwrap_or(None)
            } else {
                None
            };

            transaction.commit().await?;

            // Convert Transcript to MeetingTranscript
            let meeting_transcripts = transcripts
                .into_iter()
                .map(|t| MeetingTranscript {
                    id: t.id,
                    text: t.transcript,
                    timestamp: t.timestamp,
                    audio_start_time: t.audio_start_time,
                    audio_end_time: t.audio_end_time,
                    duration: t.duration,
                })
                .collect::<Vec<_>>();

            Ok(Some(MeetingDetails {
                id: meeting.id,
                title: meeting.title,
                created_at: meeting.created_at.0.to_rfc3339(),
                updated_at: meeting.updated_at.0.to_rfc3339(),
                transcripts: meeting_transcripts,
                has_video: meeting.has_video,
                user_id: meeting.user_id.map(|u| u.to_string()),
                project_id: meeting.project_id.map(|p| p.to_string()),
                recorder_email,
                video_url: meeting.video_url,
                drive_file_id: meeting.drive_file_id,
                upload_status: meeting.upload_status,
            }))
        } else {
            transaction.rollback().await?;
            Ok(None)
        }
    }

    /// Get meeting metadata without transcripts (for pagination)
    pub async fn get_meeting_metadata(
        pool: &PgPool,
        meeting_id: &str,
    ) -> Result<Option<MeetingModel>, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let meeting: Option<MeetingModel> =
            sqlx::query_as("SELECT * FROM meetings WHERE id = $1")
                .bind(meeting_id)
                .fetch_optional(pool)
                .await?;

        Ok(meeting)
    }

    /// Get meeting transcripts with pagination support
    pub async fn get_meeting_transcripts_paginated(
        pool: &PgPool,
        meeting_id: &str,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<Transcript>, i64), SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        // Get total count of transcripts for this meeting
        let total: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM transcripts WHERE meeting_id = $1"
        )
        .bind(meeting_id)
        .fetch_one(pool)
        .await?;

        // Get paginated transcripts ordered by audio_start_time
        let transcripts = sqlx::query_as::<_, Transcript>(
            "SELECT * FROM transcripts
             WHERE meeting_id = $1
             ORDER BY audio_start_time ASC
             LIMIT $2 OFFSET $3"
        )
        .bind(meeting_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?;

        Ok((transcripts, total.0))
    }

    pub async fn update_meeting_title(
        pool: &PgPool,
        meeting_id: &str,
        new_title: &str,
    ) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        let now = Utc::now();

        let rows_affected =
            sqlx::query("UPDATE meetings SET title = $1, updated_at = $2 WHERE id = $3")
                .bind(new_title)
                .bind(now)
                .bind(meeting_id)
                .execute(&mut *transaction)
                .await?;
        if rows_affected.rows_affected() == 0 {
            transaction.rollback().await?;
            return Ok(false);
        }
        transaction.commit().await?;
        Ok(true)
    }

    pub async fn update_meeting_name(
        pool: &PgPool,
        meeting_id: &str,
        new_title: &str,
    ) -> Result<bool, SqlxError> {
        let mut transaction = pool.begin().await?;
        let now = Utc::now();

        // Update meetings table
        let meeting_update =
            sqlx::query("UPDATE meetings SET title = $1, updated_at = $2 WHERE id = $3")
                .bind(new_title)
                .bind(now)
                .bind(meeting_id)
                .execute(&mut *transaction)
                .await?;

        if meeting_update.rows_affected() == 0 {
            transaction.rollback().await?;
            return Ok(false); // Meeting not found
        }

        // Update transcript_chunks table
        sqlx::query("UPDATE transcript_chunks SET meeting_name = $1 WHERE meeting_id = $2")
            .bind(new_title)
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await?;

        transaction.commit().await?;
        Ok(true)
    }
}

async fn delete_meeting_with_transaction(
    transaction: &mut PgConnection,
    meeting_id: &str,
) -> Result<bool, SqlxError> {
    // Check if meeting exists
    let meeting_exists: Option<(i32,)> = sqlx::query_as("SELECT 1 FROM meetings WHERE id = $1")
        .bind(meeting_id)
        .fetch_optional(&mut *transaction)
        .await?;

    if meeting_exists.is_none() {
        error!("Meeting {} not found for deletion", meeting_id);
        return Ok(false);
    }

    // Delete from related tables in proper order (cascade also handles this)
    // 1. Delete from transcript_chunks
    sqlx::query("DELETE FROM transcript_chunks WHERE meeting_id = $1")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 2. Delete from summary_processes
    sqlx::query("DELETE FROM summary_processes WHERE meeting_id = $1")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 3. Delete from transcripts
    sqlx::query("DELETE FROM transcripts WHERE meeting_id = $1")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 4. Delete from meeting_notes
    sqlx::query("DELETE FROM meeting_notes WHERE meeting_id = $1")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 5. Finally, delete the meeting
    let result = sqlx::query("DELETE FROM meetings WHERE id = $1")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    Ok(result.rows_affected() > 0)
}

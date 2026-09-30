// src/database/repositories/media_request.rs

use crate::database::models::{MediaRequest, MediaRequestWithDetails};
use sqlx::{Error as SqlxError, FromRow, PgPool};
use uuid::Uuid;

#[derive(Debug, FromRow)]
struct MediaRequestDbRow {
    pub id: Uuid,
    pub meeting_id: String,
    pub meeting_title: Option<String>,
    pub project_id: Option<Uuid>,
    pub requested_by: Uuid,
    pub requester_email: Option<String>,
    pub recorder_id: Uuid,
    pub recorder_email: Option<String>,
    pub media_type: String,
    pub status: String,
    pub progress: i32,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

impl From<MediaRequestDbRow> for MediaRequestWithDetails {
    fn from(r: MediaRequestDbRow) -> Self {
        MediaRequestWithDetails {
            id: r.id.to_string(),
            meeting_id: r.meeting_id,
            meeting_title: r.meeting_title.unwrap_or_else(|| "Untitled Meeting".to_string()),
            project_id: r.project_id.map(|p| p.to_string()),
            requested_by: r.requested_by.to_string(),
            requester_email: r.requester_email,
            recorder_id: r.recorder_id.to_string(),
            recorder_email: r.recorder_email,
            media_type: r.media_type,
            status: r.status,
            progress: r.progress,
            created_at: r.created_at.to_rfc3339(),
            updated_at: r.updated_at.to_rfc3339(),
        }
    }
}

pub struct MediaRequestsRepository;

impl MediaRequestsRepository {
    /// Create a new media request or return an existing pending/transferring request
    pub async fn create_or_get_pending_request(
        pool: &PgPool,
        meeting_id: &str,
        project_id: Option<Uuid>,
        requested_by: Uuid,
        recorder_id: Uuid,
        media_type: &str,
    ) -> Result<MediaRequestWithDetails, SqlxError> {
        // First check if an active (pending or transferring) request already exists
        let existing: Option<MediaRequest> = sqlx::query_as(
            r#"
            SELECT * FROM media_requests
            WHERE meeting_id = $1 AND requested_by = $2 AND status IN ('pending', 'transferring')
            ORDER BY created_at DESC
            LIMIT 1
            "#,
        )
        .bind(meeting_id)
        .bind(requested_by)
        .fetch_optional(pool)
        .await?;

        let request_id = match existing {
            Some(req) => req.id,
            None => {
                let new_id = Uuid::new_v4();
                sqlx::query(
                    r#"
                    INSERT INTO media_requests (
                        id, meeting_id, project_id, requested_by, recorder_id, media_type, status, progress, created_at, updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0, NOW(), NOW())
                    "#,
                )
                .bind(new_id)
                .bind(meeting_id)
                .bind(project_id)
                .bind(requested_by)
                .bind(recorder_id)
                .bind(media_type)
                .execute(pool)
                .await?;

                new_id
            }
        };

        Self::get_request_details(pool, request_id)
            .await?
            .ok_or_else(|| SqlxError::RowNotFound)
    }

    /// Retrieve full details of a single media request by ID
    pub async fn get_request_details(
        pool: &PgPool,
        request_id: Uuid,
    ) -> Result<Option<MediaRequestWithDetails>, SqlxError> {
        let row = sqlx::query_as::<_, MediaRequestDbRow>(
            r#"
            SELECT 
                r.id,
                r.meeting_id,
                m.title AS meeting_title,
                r.project_id,
                r.requested_by,
                u_req.email AS requester_email,
                r.recorder_id,
                u_rec.email AS recorder_email,
                r.media_type,
                r.status,
                r.progress,
                r.created_at,
                r.updated_at
            FROM media_requests r
            LEFT JOIN meetings m ON m.id = r.meeting_id
            LEFT JOIN app_users u_req ON u_req.id = r.requested_by
            LEFT JOIN app_users u_rec ON u_rec.id = r.recorder_id
            WHERE r.id = $1
            "#,
        )
        .bind(request_id)
        .fetch_optional(pool)
        .await?;

        Ok(row.map(Into::into))
    }

    /// Retrieve pending incoming requests where the current user is the recorder
    pub async fn get_incoming_pending_requests(
        pool: &PgPool,
        recorder_id: Uuid,
    ) -> Result<Vec<MediaRequestWithDetails>, SqlxError> {
        let rows = sqlx::query_as::<_, MediaRequestDbRow>(
            r#"
            SELECT 
                r.id,
                r.meeting_id,
                m.title AS meeting_title,
                r.project_id,
                r.requested_by,
                u_req.email AS requester_email,
                r.recorder_id,
                u_rec.email AS recorder_email,
                r.media_type,
                r.status,
                r.progress,
                r.created_at,
                r.updated_at
            FROM media_requests r
            LEFT JOIN meetings m ON m.id = r.meeting_id
            LEFT JOIN app_users u_req ON u_req.id = r.requested_by
            LEFT JOIN app_users u_rec ON u_rec.id = r.recorder_id
            WHERE r.recorder_id = $1 AND r.status = 'pending'
            ORDER BY r.created_at DESC
            "#,
        )
        .bind(recorder_id)
        .fetch_all(pool)
        .await?;

        Ok(rows.into_iter().map(Into::into).collect())
    }

    /// Retrieve the most recent media request for a specific meeting and requester
    pub async fn get_request_for_meeting(
        pool: &PgPool,
        meeting_id: &str,
        requested_by: Uuid,
    ) -> Result<Option<MediaRequestWithDetails>, SqlxError> {
        let row = sqlx::query_as::<_, MediaRequestDbRow>(
            r#"
            SELECT 
                r.id,
                r.meeting_id,
                m.title AS meeting_title,
                r.project_id,
                r.requested_by,
                u_req.email AS requester_email,
                r.recorder_id,
                u_rec.email AS recorder_email,
                r.media_type,
                r.status,
                r.progress,
                r.created_at,
                r.updated_at
            FROM media_requests r
            LEFT JOIN meetings m ON m.id = r.meeting_id
            LEFT JOIN app_users u_req ON u_req.id = r.requested_by
            LEFT JOIN app_users u_rec ON u_rec.id = r.recorder_id
            WHERE r.meeting_id = $1 AND r.requested_by = $2
            ORDER BY r.created_at DESC
            LIMIT 1
            "#,
        )
        .bind(meeting_id)
        .bind(requested_by)
        .fetch_optional(pool)
        .await?;

        Ok(row.map(Into::into))
    }

    /// Update media request status and progress
    pub async fn update_status(
        pool: &PgPool,
        request_id: Uuid,
        status: &str,
        progress: i32,
    ) -> Result<bool, SqlxError> {
        let res = sqlx::query(
            r#"
            UPDATE media_requests
            SET status = $1, progress = $2, updated_at = NOW()
            WHERE id = $3
            "#,
        )
        .bind(status)
        .bind(progress)
        .bind(request_id)
        .execute(pool)
        .await?;

        Ok(res.rows_affected() > 0)
    }
}

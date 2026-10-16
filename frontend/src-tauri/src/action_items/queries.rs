// src/action_items/queries.rs

use crate::database::models::ResolvedActionItem;
use serde::{Deserialize, Serialize};
use sqlx::{Error as SqlxError, PgPool};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct ActionItemsCount {
    pub open: i64,
    pub needs_review: i64,
    pub done: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ListActionItemsResponse {
    pub items: Vec<ResolvedActionItem>,
    pub counts: ActionItemsCount,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ActionItemPatch {
    pub status: Option<String>,
    pub content: Option<String>,
    pub due_date: Option<String>, // YYYY-MM-DD
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ActionItemEvidence {
    pub id: String,
    pub task: String,
    pub meeting_id: String,
    pub meeting_title: String,
    pub start_seconds: Option<f64>,
    pub turns: Vec<EvidenceTurnSnippet>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EvidenceTurnSnippet {
    pub id: String,
    pub speaker_name: String,
    pub text: String,
    pub timestamp: f64,
}

pub struct ActionItemsQueries;

impl ActionItemsQueries {
    /// Get tab counts for the current user across Open, Needs Review, and Done
    pub async fn get_tab_counts(
        pool: &PgPool,
        user_id: Uuid,
        project_id: Option<Uuid>,
    ) -> Result<ActionItemsCount, SqlxError> {
        // Open count
        let open_count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM action_items_resolved r
             JOIN meetings m ON m.id = r.meeting_id
             WHERE (r.assignee_user_id = $1 OR (r.assignee_user_id IS NULL AND m.user_id = $1))
               AND r.status IN ('open', 'in_progress')
               AND r.assignment_type IN ('delegated', 'volunteered')
               AND ($2::uuid IS NULL OR r.project_id = $2)",
        )
        .bind(user_id)
        .bind(project_id)
        .fetch_one(pool)
        .await?;

        // Needs Review count
        let needs_review_count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM action_items_resolved r
             JOIN meetings m ON m.id = r.meeting_id
             WHERE r.status = 'open' AND (
                 (r.assignee_user_id = $1 AND r.assignment_type = 'proposed_unconfirmed')
                 OR (m.user_id = $1 AND (r.assignee_user_id IS NULL OR r.speaker_unresolved = true))
             )
             AND ($2::uuid IS NULL OR r.project_id = $2)",
        )
        .bind(user_id)
        .bind(project_id)
        .fetch_one(pool)
        .await?;

        // Done count
        let done_count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM action_items_resolved r
             JOIN meetings m ON m.id = r.meeting_id
             WHERE (r.assignee_user_id = $1 OR m.user_id = $1)
               AND r.status = 'done'
               AND ($2::uuid IS NULL OR r.project_id = $2)",
        )
        .bind(user_id)
        .bind(project_id)
        .fetch_one(pool)
        .await?;

        Ok(ActionItemsCount {
            open: open_count.0,
            needs_review: needs_review_count.0,
            done: done_count.0,
        })
    }

    /// List action items for the specified tab with optional search and project filter
    pub async fn list_action_items(
        pool: &PgPool,
        user_id: Uuid,
        tab: &str,
        project_id: Option<Uuid>,
        search: Option<&str>,
    ) -> Result<ListActionItemsResponse, SqlxError> {
        let counts = Self::get_tab_counts(pool, user_id, project_id).await?;
        let search_pattern = search.map(|s| format!("%{}%", s.trim().to_lowercase()));

        let items: Vec<ResolvedActionItem> = match tab {
            "needs_review" => {
                sqlx::query_as::<_, ResolvedActionItem>(
                    "SELECT r.* FROM action_items_resolved r
                     JOIN meetings m ON m.id = r.meeting_id
                     WHERE r.status = 'open' AND (
                         (r.assignee_user_id = $1 AND r.assignment_type = 'proposed_unconfirmed')
                         OR (m.user_id = $1 AND (r.assignee_user_id IS NULL OR r.speaker_unresolved = true))
                     )
                     AND ($2::uuid IS NULL OR r.project_id = $2)
                     AND ($3::text IS NULL OR LOWER(r.task) LIKE $3 OR LOWER(r.meeting_title) LIKE $3)
                     ORDER BY (r.due_date IS NULL), r.due_date ASC, r.meeting_date DESC
                     LIMIT 100",
                )
                .bind(user_id)
                .bind(project_id)
                .bind(search_pattern)
                .fetch_all(pool)
                .await?
            }
            "done" => {
                sqlx::query_as::<_, ResolvedActionItem>(
                    "SELECT r.* FROM action_items_resolved r
                     JOIN meetings m ON m.id = r.meeting_id
                     WHERE (r.assignee_user_id = $1 OR m.user_id = $1)
                       AND r.status = 'done'
                       AND ($2::uuid IS NULL OR r.project_id = $2)
                       AND ($3::text IS NULL OR LOWER(r.task) LIKE $3 OR LOWER(r.meeting_title) LIKE $3)
                     ORDER BY r.completed_at DESC NULLS LAST, r.meeting_date DESC
                     LIMIT 100",
                )
                .bind(user_id)
                .bind(project_id)
                .bind(search_pattern)
                .fetch_all(pool)
                .await?
            }
            _ => {
                // "open" (default)
                sqlx::query_as::<_, ResolvedActionItem>(
                    "SELECT r.* FROM action_items_resolved r
                     JOIN meetings m ON m.id = r.meeting_id
                     WHERE (r.assignee_user_id = $1 OR (r.assignee_user_id IS NULL AND m.user_id = $1))
                       AND r.status IN ('open', 'in_progress')
                       AND r.assignment_type IN ('delegated', 'volunteered')
                       AND ($2::uuid IS NULL OR r.project_id = $2)
                       AND ($3::text IS NULL OR LOWER(r.task) LIKE $3 OR LOWER(r.meeting_title) LIKE $3)
                     ORDER BY (r.due_date IS NULL), r.due_date ASC, r.meeting_date DESC
                     LIMIT 100",
                )
                .bind(user_id)
                .bind(project_id)
                .bind(search_pattern)
                .fetch_all(pool)
                .await?
            }
        };

        Ok(ListActionItemsResponse { items, counts })
    }

    /// Update patch on an action item (status, due_date, content)
    pub async fn update_action_item(
        pool: &PgPool,
        item_id: Uuid,
        patch: ActionItemPatch,
    ) -> Result<bool, SqlxError> {
        let is_done = patch.status.as_deref() == Some("done");
        let parsed_due_date = patch.due_date.as_deref().and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());

        let res = sqlx::query(
            "UPDATE meeting_insights
             SET status = COALESCE($1, status),
                 content = COALESCE($2, content),
                 due_date = COALESCE($3, due_date),
                 completed_at = CASE WHEN $4 THEN NOW() WHEN $1 IS NOT NULL AND $1 != 'done' THEN NULL ELSE completed_at END,
                 user_edited = TRUE,
                 updated_at = NOW()
             WHERE id = $5",
        )
        .bind(patch.status)
        .bind(patch.content)
        .bind(parsed_due_date)
        .bind(is_done)
        .bind(item_id)
        .execute(pool)
        .await?;

        Ok(res.rows_affected() > 0)
    }

    /// Confirm proposed item into delegated
    pub async fn confirm_action_item(pool: &PgPool, item_id: Uuid) -> Result<bool, SqlxError> {
        let res = sqlx::query(
            "UPDATE meeting_insights
             SET assignment_type = 'delegated',
                 speaker_unresolved = FALSE,
                 user_edited = TRUE,
                 updated_at = NOW()
             WHERE id = $1",
        )
        .bind(item_id)
        .execute(pool)
        .await?;

        Ok(res.rows_affected() > 0)
    }

    /// Reject action item ("Not mine" -> set dropped)
    pub async fn reject_action_item(pool: &PgPool, item_id: Uuid) -> Result<bool, SqlxError> {
        let res = sqlx::query(
            "UPDATE meeting_insights
             SET status = 'dropped',
                 user_edited = TRUE,
                 updated_at = NOW()
             WHERE id = $1",
        )
        .bind(item_id)
        .execute(pool)
        .await?;

        Ok(res.rows_affected() > 0)
    }

    /// Claim action item for current user
    pub async fn claim_action_item(
        pool: &PgPool,
        item_id: Uuid,
        person_id: Uuid,
    ) -> Result<bool, SqlxError> {
        let res = sqlx::query(
            "UPDATE meeting_insights
             SET assignee_person_id = $1,
                 assignment_type = 'volunteered',
                 speaker_unresolved = FALSE,
                 user_edited = TRUE,
                 updated_at = NOW()
             WHERE id = $2",
        )
        .bind(person_id)
        .bind(item_id)
        .execute(pool)
        .await?;

        Ok(res.rows_affected() > 0)
    }

    /// Fetch transcript evidence turns and start offset for an action item
    pub async fn get_action_item_evidence(
        pool: &PgPool,
        item_id: Uuid,
    ) -> Result<Option<ActionItemEvidence>, SqlxError> {
        let row: Option<(Uuid, String, String, String, Option<f64>, Option<Vec<String>>)> = sqlx::query_as(
            "SELECT mi.id, mi.content, mi.meeting_id, m.title, mi.start_seconds, mi.evidence_turn_ids
             FROM meeting_insights mi
             JOIN meetings m ON m.id = mi.meeting_id
             WHERE mi.id = $1",
        )
        .bind(item_id)
        .fetch_optional(pool)
        .await?;

        let (id, content, meeting_id, title, start_seconds, _evidence_turns) = match row {
            Some(r) => r,
            None => return Ok(None),
        };

        // Query transcript snippets matching the meeting around start_seconds
        let turns: Vec<(String, String, Option<f64>, Option<String>)> = sqlx::query_as(
            "SELECT t.id, t.transcript, t.audio_start_time, COALESCE(s.display_name, 'Speaker')
             FROM transcripts t
             LEFT JOIN meeting_speakers s ON s.id = t.speaker_id
             WHERE t.meeting_id = $1
             ORDER BY t.audio_start_time ASC
             LIMIT 10",
        )
        .bind(&meeting_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();

        let snippets = turns
            .into_iter()
            .map(|(t_id, text, t_time, spk)| EvidenceTurnSnippet {
                id: t_id,
                speaker_name: spk.unwrap_or_else(|| "Unknown".to_string()),
                text,
                timestamp: t_time.unwrap_or(0.0),
            })
            .collect();

        Ok(Some(ActionItemEvidence {
            id: id.to_string(),
            task: content,
            meeting_id,
            meeting_title: title,
            start_seconds,
            turns: snippets,
        }))
    }
}

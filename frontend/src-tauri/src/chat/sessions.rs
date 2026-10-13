// frontend/src-tauri/src/chat/sessions.rs

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tauri::State;
use uuid::Uuid;

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionRecord {
    pub id: String,
    pub user_id: String,
    pub title: String,
    pub title_source: String,
    pub scope_project_ids: Option<Vec<String>>,
    pub pinned: bool,
    pub archived_at: Option<String>,
    pub message_count: i32,
    pub last_message_at: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageDetail {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub citations: Option<serde_json::Value>,
    pub status: String,
    pub model: Option<String>,
    pub created_at: String,
}

pub struct ChatSessionRepository;

impl ChatSessionRepository {
    /// List sessions for the authenticated user
    pub async fn list_sessions(
        pool: &PgPool,
        user_id: Uuid,
        include_archived: bool,
    ) -> Result<Vec<ChatSessionRecord>, String> {
        let rows = sqlx::query_as::<
            _,
            (
                Uuid,
                Uuid,
                Option<String>,
                String,
                Option<Vec<Uuid>>,
                bool,
                Option<chrono::DateTime<Utc>>,
                i32,
                chrono::DateTime<Utc>,
                chrono::DateTime<Utc>,
            ),
        >(
            r#"
            SELECT 
                id, user_id, title, title_source, scope_project_ids,
                pinned, archived_at, message_count, last_message_at, created_at
            FROM chat_sessions
            WHERE user_id = $1 AND deleted_at IS NULL
              AND ($2 = true OR archived_at IS NULL)
            ORDER BY pinned DESC, last_message_at DESC
            LIMIT 50
            "#,
        )
        .bind(user_id)
        .bind(include_archived)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Database error fetching chat sessions: {}", e))?;

        let sessions = rows
            .into_iter()
            .map(
                |(
                    id,
                    uid,
                    title,
                    title_source,
                    scopes,
                    pinned,
                    archived_at,
                    message_count,
                    last_message_at,
                    created_at,
                )| {
                    ChatSessionRecord {
                        id: id.to_string(),
                        user_id: uid.to_string(),
                        title: title.unwrap_or_else(|| "New Conversation".to_string()),
                        title_source,
                        scope_project_ids: scopes.map(|v| v.into_iter().map(|s| s.to_string()).collect()),
                        pinned,
                        archived_at: archived_at.map(|t| t.to_rfc3339()),
                        message_count,
                        last_message_at: last_message_at.to_rfc3339(),
                        created_at: created_at.to_rfc3339(),
                    }
                },
            )
            .collect();

        Ok(sessions)
    }

    /// Create a new session
    pub async fn create_session(
        pool: &PgPool,
        user_id: Uuid,
        scope_project_ids: Option<Vec<Uuid>>,
        title: Option<String>,
    ) -> Result<ChatSessionRecord, String> {
        let session_id = Uuid::new_v4();
        let default_title = title.unwrap_or_else(|| "New Conversation".to_string());

        sqlx::query(
            r#"
            INSERT INTO chat_sessions (id, user_id, title, title_source, scope_project_ids)
            VALUES ($1, $2, $3, 'auto', $4)
            "#,
        )
        .bind(session_id)
        .bind(user_id)
        .bind(&default_title)
        .bind(&scope_project_ids)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to create chat session: {}", e))?;

        let now = Utc::now().to_rfc3339();
        Ok(ChatSessionRecord {
            id: session_id.to_string(),
            user_id: user_id.to_string(),
            title: default_title,
            title_source: "auto".to_string(),
            scope_project_ids: scope_project_ids.map(|v| v.into_iter().map(|s| s.to_string()).collect()),
            pinned: false,
            archived_at: None,
            message_count: 0,
            last_message_at: now.clone(),
            created_at: now,
        })
    }

    /// Rename session
    pub async fn rename_session(
        pool: &PgPool,
        user_id: Uuid,
        session_id: Uuid,
        new_title: &str,
    ) -> Result<bool, String> {
        let res = sqlx::query(
            r#"
            UPDATE chat_sessions
            SET title = $1, title_source = 'user', updated_at = NOW()
            WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL
            "#,
        )
        .bind(new_title)
        .bind(session_id)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to rename chat session: {}", e))?;

        Ok(res.rows_affected() > 0)
    }

    /// Pin / Unpin session
    pub async fn pin_session(
        pool: &PgPool,
        user_id: Uuid,
        session_id: Uuid,
        pinned: bool,
    ) -> Result<bool, String> {
        let res = sqlx::query(
            r#"
            UPDATE chat_sessions
            SET pinned = $1, updated_at = NOW()
            WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL
            "#,
        )
        .bind(pinned)
        .bind(session_id)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to toggle pin: {}", e))?;

        Ok(res.rows_affected() > 0)
    }

    /// Archive / Unarchive session
    pub async fn archive_session(
        pool: &PgPool,
        user_id: Uuid,
        session_id: Uuid,
        archive: bool,
    ) -> Result<bool, String> {
        let res = sqlx::query(
            r#"
            UPDATE chat_sessions
            SET archived_at = CASE WHEN $1 = true THEN NOW() ELSE NULL END, updated_at = NOW()
            WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL
            "#,
        )
        .bind(archive)
        .bind(session_id)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to toggle archive: {}", e))?;

        Ok(res.rows_affected() > 0)
    }

    /// Soft delete session
    pub async fn delete_session(
        pool: &PgPool,
        user_id: Uuid,
        session_id: Uuid,
    ) -> Result<bool, String> {
        let res = sqlx::query(
            r#"
            UPDATE chat_sessions
            SET deleted_at = NOW()
            WHERE id = $1 AND user_id = $2
            "#,
        )
        .bind(session_id)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to delete session: {}", e))?;

        Ok(res.rows_affected() > 0)
    }
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

#[tauri::command]
pub async fn api_chat_list_sessions(
    state: State<'_, AppState>,
    include_archived: Option<bool>,
) -> Result<Vec<ChatSessionRecord>, String> {
    let pool = state.db_manager.pool();
    let user_id = *state.current_user_id.read().await;

    let uid = match user_id {
        Some(u) => u,
        None => return Ok(Vec::new()),
    };

    ChatSessionRepository::list_sessions(pool, uid, include_archived.unwrap_or(false)).await
}

#[tauri::command]
pub async fn api_chat_create_session(
    state: State<'_, AppState>,
    scope_project_ids: Option<Vec<String>>,
    title: Option<String>,
) -> Result<ChatSessionRecord, String> {
    let pool = state.db_manager.pool();
    let user_id = *state.current_user_id.read().await;

    let uid = match user_id {
        Some(u) => u,
        None => return Err("Authentication required to create a chat session".to_string()),
    };

    let scopes = scope_project_ids.map(|v| {
        v.into_iter()
            .filter_map(|s| Uuid::parse_str(&s).ok())
            .collect()
    });

    ChatSessionRepository::create_session(pool, uid, scopes, title).await
}

#[tauri::command]
pub async fn api_chat_rename_session(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
) -> Result<bool, String> {
    let pool = state.db_manager.pool();
    let user_id = *state.current_user_id.read().await;
    let uid = user_id.ok_or_else(|| "Authentication required".to_string())?;
    let sid = Uuid::parse_str(&session_id).map_err(|_| "Invalid session ID format".to_string())?;

    ChatSessionRepository::rename_session(pool, uid, sid, &title).await
}

#[tauri::command]
pub async fn api_chat_pin_session(
    state: State<'_, AppState>,
    session_id: String,
    pinned: bool,
) -> Result<bool, String> {
    let pool = state.db_manager.pool();
    let user_id = *state.current_user_id.read().await;
    let uid = user_id.ok_or_else(|| "Authentication required".to_string())?;
    let sid = Uuid::parse_str(&session_id).map_err(|_| "Invalid session ID format".to_string())?;

    ChatSessionRepository::pin_session(pool, uid, sid, pinned).await
}

#[tauri::command]
pub async fn api_chat_archive_session(
    state: State<'_, AppState>,
    session_id: String,
    archive: bool,
) -> Result<bool, String> {
    let pool = state.db_manager.pool();
    let user_id = *state.current_user_id.read().await;
    let uid = user_id.ok_or_else(|| "Authentication required".to_string())?;
    let sid = Uuid::parse_str(&session_id).map_err(|_| "Invalid session ID format".to_string())?;

    ChatSessionRepository::archive_session(pool, uid, sid, archive).await
}

#[tauri::command]
pub async fn api_chat_delete_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool, String> {
    let pool = state.db_manager.pool();
    let user_id = *state.current_user_id.read().await;
    let uid = user_id.ok_or_else(|| "Authentication required".to_string())?;
    let sid = Uuid::parse_str(&session_id).map_err(|_| "Invalid session ID format".to_string())?;

    ChatSessionRepository::delete_session(pool, uid, sid).await
}

// frontend/src-tauri/src/chat/sharing.rs

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tauri::State;
use uuid::Uuid;

use crate::state::AppState;
use super::sessions::ChatSessionRecord;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatShareRecord {
    pub id: String,
    pub session_id: String,
    pub created_by: String,
    pub visibility: String,
    pub title: String,
    pub project_ids: Vec<String>,
    pub include_sources: bool,
    pub snapshot_upto_seq: i64,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
    pub view_count: i32,
    pub last_viewed_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateShareResult {
    pub share_id: String,
    pub token: String,
    pub share_url: String,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMessageDetail {
    pub position: i32,
    pub role: String,
    pub content: String,
    pub citations: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedChatSnapshot {
    pub share: ChatShareRecord,
    pub messages: Vec<SharedMessageDetail>,
}

pub struct ChatShareRepository;

impl ChatShareRepository {
    /// Create an immutable snapshot share of a chat session
    pub async fn create_share(
        pool: &PgPool,
        user_id: Uuid,
        session_id: Uuid,
        visibility: &str,
        include_sources: bool,
        expires_days: Option<i64>,
    ) -> Result<CreateShareResult, String> {
        // 1. Fetch session info to verify ownership and title
        let session = sqlx::query_as::<_, (String, Option<Vec<Uuid>>)>(
            "SELECT title, scope_project_ids FROM chat_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
        )
        .bind(session_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Database error validating session: {}", e))?
        .ok_or_else(|| "Chat session not found or permission denied".to_string())?;

        let title = session.0;
        let project_ids = session.1.unwrap_or_default();

        // 2. Generate secure token
        let token = format!("csh_{}_{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let share_id = Uuid::new_v4();

        // 3. Compute expiration timestamp
        let expires_at = expires_days.map(|d| Utc::now() + chrono::Duration::days(d));

        // Normalize visibility to match database CHECK constraint: 'members' | 'link'
        let db_visibility = match visibility.trim().to_lowercase().as_str() {
            "link" | "public" => "link",
            _ => "members",
        };

        // 4. Insert into chat_shares using pgcrypto digest for token_hash
        sqlx::query(
            r#"
            INSERT INTO chat_shares (
                id, session_id, created_by, visibility, token_hash,
                title, project_ids, include_sources, snapshot_upto_seq, expires_at
            )
            VALUES (
                $1, $2, $3, $4, encode(digest($5, 'sha256'), 'hex'),
                $6, $7, $8, 0, $9
            )
            "#,
        )
        .bind(share_id)
        .bind(session_id)
        .bind(user_id)
        .bind(db_visibility)
        .bind(&token)
        .bind(&title)
        .bind(&project_ids)
        .bind(include_sources)
        .bind(expires_at)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to create chat share: {}", e))?;

        // 5. Copy messages up to current moment into chat_share_messages
        let messages = sqlx::query_as::<_, (String, String, Option<String>)>(
            r#"
            SELECT role, content, citations
            FROM chat_messages
            WHERE chat_session_id = $1::text OR session_id = $1
            ORDER BY created_at ASC
            "#,
        )
        .bind(session_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();

        for (idx, (role, content, citations_str)) in messages.into_iter().enumerate() {
            let citations_val: serde_json::Value = if include_sources {
                citations_str
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or_else(|| serde_json::json!([]))
            } else {
                serde_json::json!([])
            };

            let _ = sqlx::query(
                r#"
                INSERT INTO chat_share_messages (share_id, position, role, content, citations)
                VALUES ($1, $2, $3, $4, $5)
                "#,
            )
            .bind(share_id)
            .bind(idx as i32)
            .bind(role)
            .bind(content)
            .bind(citations_val)
            .execute(pool)
            .await;
        }

        let share_url = format!("crestmeet://share/{}", token);
        Ok(CreateShareResult {
            share_id: share_id.to_string(),
            token,
            share_url,
            expires_at: expires_at.map(|t| t.to_rfc3339()),
        })
    }

    /// Retrieve shared chat snapshot by token
    pub async fn get_shared_chat(
        pool: &PgPool,
        token: &str,
    ) -> Result<SharedChatSnapshot, String> {
        let row = sqlx::query_as::<
            _,
            (
                Uuid,
                Uuid,
                Uuid,
                String,
                String,
                Vec<Uuid>,
                bool,
                i64,
                Option<chrono::DateTime<Utc>>,
                Option<chrono::DateTime<Utc>>,
                i32,
                Option<chrono::DateTime<Utc>>,
                chrono::DateTime<Utc>,
            ),
        >(
            r#"
            SELECT 
                id, session_id, created_by, visibility, title,
                project_ids, include_sources, snapshot_upto_seq,
                expires_at, revoked_at, view_count, last_viewed_at, created_at
            FROM chat_shares
            WHERE token_hash = encode(digest($1, 'sha256'), 'hex')
              AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > NOW())
            "#,
        )
        .bind(token)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Database error fetching shared chat: {}", e))?
        .ok_or_else(|| "This shared conversation link has expired, was revoked, or does not exist.".to_string())?;

        let share_id = row.0;

        // Increment view count best-effort
        let _ = sqlx::query(
            "UPDATE chat_shares SET view_count = view_count + 1, last_viewed_at = NOW() WHERE id = $1"
        )
        .bind(share_id)
        .execute(pool)
        .await;

        let share_record = ChatShareRecord {
            id: row.0.to_string(),
            session_id: row.1.to_string(),
            created_by: row.2.to_string(),
            visibility: row.3,
            title: row.4,
            project_ids: row.5.into_iter().map(|p| p.to_string()).collect(),
            include_sources: row.6,
            snapshot_upto_seq: row.7,
            expires_at: row.8.map(|t| t.to_rfc3339()),
            revoked_at: row.9.map(|t| t.to_rfc3339()),
            view_count: row.10 + 1,
            last_viewed_at: Some(Utc::now().to_rfc3339()),
            created_at: row.12.to_rfc3339(),
        };

        // Fetch snapshot messages
        let msg_rows = sqlx::query_as::<_, (i32, String, String, Option<serde_json::Value>)>(
            r#"
            SELECT position, role, content, citations
            FROM chat_share_messages
            WHERE share_id = $1
            ORDER BY position ASC
            "#,
        )
        .bind(share_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();

        let messages = msg_rows
            .into_iter()
            .map(|(position, role, content, citations)| SharedMessageDetail {
                position,
                role,
                content,
                citations,
            })
            .collect();

        Ok(SharedChatSnapshot {
            share: share_record,
            messages,
        })
    }

    /// Fork a shared chat into a new live session for the caller
    pub async fn fork_shared_chat(
        pool: &PgPool,
        user_id: Uuid,
        token: &str,
    ) -> Result<ChatSessionRecord, String> {
        let snapshot = Self::get_shared_chat(pool, token).await?;
        let new_session_id = Uuid::new_v4();
        let new_title = format!("{} (Shared)", snapshot.share.title);

        let project_uuids: Vec<Uuid> = snapshot
            .share
            .project_ids
            .iter()
            .filter_map(|s| Uuid::parse_str(s).ok())
            .collect();

        sqlx::query(
            r#"
            INSERT INTO chat_sessions (id, user_id, title, title_source, scope_project_ids)
            VALUES ($1, $2, $3, 'user', $4)
            "#,
        )
        .bind(new_session_id)
        .bind(user_id)
        .bind(&new_title)
        .bind(&project_uuids)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to create forked session: {}", e))?;

        // Copy snapshot messages to live chat_messages
        for msg in &snapshot.messages {
            let msg_id = format!("msg-{}", Uuid::new_v4());
            let citations_json = msg.citations.as_ref().map(|c| c.to_string());

            let _ = sqlx::query(
                r#"
                INSERT INTO chat_messages (id, user_id, chat_session_id, session_id, role, content, citations)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                "#,
            )
            .bind(&msg_id)
            .bind(user_id)
            .bind(new_session_id.to_string())
            .bind(new_session_id)
            .bind(&msg.role)
            .bind(&msg.content)
            .bind(citations_json)
            .execute(pool)
            .await;
        }

        let now = Utc::now().to_rfc3339();
        Ok(ChatSessionRecord {
            id: new_session_id.to_string(),
            user_id: user_id.to_string(),
            title: new_title,
            title_source: "user".to_string(),
            scope_project_ids: Some(snapshot.share.project_ids),
            pinned: false,
            archived_at: None,
            message_count: snapshot.messages.len() as i32,
            last_message_at: now.clone(),
            created_at: now,
        })
    }

    /// Revoke a shared chat link
    pub async fn revoke_share(
        pool: &PgPool,
        user_id: Uuid,
        share_id: Uuid,
    ) -> Result<bool, String> {
        let res = sqlx::query(
            "UPDATE chat_shares SET revoked_at = NOW(), updated_at = NOW() WHERE id = $1 AND created_by = $2"
        )
        .bind(share_id)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to revoke share: {}", e))?;

        Ok(res.rows_affected() > 0)
    }

    /// List active shares for a session
    pub async fn list_shares_for_session(
        pool: &PgPool,
        user_id: Uuid,
        session_id: Uuid,
    ) -> Result<Vec<ChatShareRecord>, String> {
        let rows = sqlx::query_as::<
            _,
            (
                Uuid,
                Uuid,
                Uuid,
                String,
                String,
                Vec<Uuid>,
                bool,
                i64,
                Option<chrono::DateTime<Utc>>,
                Option<chrono::DateTime<Utc>>,
                i32,
                Option<chrono::DateTime<Utc>>,
                chrono::DateTime<Utc>,
            ),
        >(
            r#"
            SELECT 
                id, session_id, created_by, visibility, title,
                project_ids, include_sources, snapshot_upto_seq,
                expires_at, revoked_at, view_count, last_viewed_at, created_at
            FROM chat_shares
            WHERE session_id = $1 AND created_by = $2
            ORDER BY created_at DESC
            "#,
        )
        .bind(session_id)
        .bind(user_id)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Failed to list shares: {}", e))?;

        let records = rows
            .into_iter()
            .map(|r| ChatShareRecord {
                id: r.0.to_string(),
                session_id: r.1.to_string(),
                created_by: r.2.to_string(),
                visibility: r.3,
                title: r.4,
                project_ids: r.5.into_iter().map(|p| p.to_string()).collect(),
                include_sources: r.6,
                snapshot_upto_seq: r.7,
                expires_at: r.8.map(|t| t.to_rfc3339()),
                revoked_at: r.9.map(|t| t.to_rfc3339()),
                view_count: r.10,
                last_viewed_at: r.11.map(|t| t.to_rfc3339()),
                created_at: r.12.to_rfc3339(),
            })
            .collect();

        Ok(records)
    }
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

#[tauri::command]
pub async fn api_chat_create_share(
    state: State<'_, AppState>,
    session_id: String,
    visibility: String,
    include_sources: bool,
    expires_days: Option<i64>,
) -> Result<CreateShareResult, String> {
    let pool = state.db_manager.pool();
    let current_user = state
        .current_user_id
        .read()
        .await
        .ok_or_else(|| "User must be logged in to create a share".to_string())?;
    let s_uuid = Uuid::parse_str(&session_id).map_err(|_| "Invalid session ID format".to_string())?;

    ChatShareRepository::create_share(
        pool,
        current_user,
        s_uuid,
        &visibility,
        include_sources,
        expires_days,
    )
    .await
}

#[tauri::command]
pub async fn api_chat_get_shared(
    state: State<'_, AppState>,
    token: String,
) -> Result<SharedChatSnapshot, String> {
    let pool = state.db_manager.pool();
    ChatShareRepository::get_shared_chat(pool, &token).await
}

#[tauri::command]
pub async fn api_chat_fork_shared(
    state: State<'_, AppState>,
    token: String,
) -> Result<ChatSessionRecord, String> {
    let pool = state.db_manager.pool();
    let current_user = state
        .current_user_id
        .read()
        .await
        .ok_or_else(|| "User must be logged in to continue a shared conversation".to_string())?;

    ChatShareRepository::fork_shared_chat(pool, current_user, &token).await
}

#[tauri::command]
pub async fn api_chat_revoke_share(
    state: State<'_, AppState>,
    share_id: String,
) -> Result<bool, String> {
    let pool = state.db_manager.pool();
    let current_user = state
        .current_user_id
        .read()
        .await
        .ok_or_else(|| "User must be logged in to revoke a share".to_string())?;
    let s_uuid = Uuid::parse_str(&share_id).map_err(|_| "Invalid share ID format".to_string())?;

    ChatShareRepository::revoke_share(pool, current_user, s_uuid).await
}

#[tauri::command]
pub async fn api_chat_list_shares(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<ChatShareRecord>, String> {
    let pool = state.db_manager.pool();
    let current_user = state
        .current_user_id
        .read()
        .await
        .ok_or_else(|| "User must be logged in to view shares".to_string())?;
    let s_uuid = Uuid::parse_str(&session_id).map_err(|_| "Invalid session ID format".to_string())?;

    ChatShareRepository::list_shares_for_session(pool, current_user, s_uuid).await
}

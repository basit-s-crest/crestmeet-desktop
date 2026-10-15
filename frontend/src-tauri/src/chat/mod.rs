// src/chat/mod.rs

pub mod sessions;
pub use sessions::*;

pub mod sharing;
pub use sharing::*;

use chrono::Utc;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::HashSet;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;
use tracing::{info, warn};
use uuid::Uuid;

use crate::database::repositories::setting::SettingsRepository;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCitation {
    pub label: Option<String>,
    pub meeting_id: String,
    pub meeting_title: String,
    pub date: String,
    pub snippet: Option<String>,
    pub start_seconds: Option<f64>,
    pub end_seconds: Option<f64>,
    pub speaker: Option<String>,
    pub project_name: Option<String>,
    pub chunk_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentMeetingInfo {
    pub id: String,
    pub title: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatApiResponse {
    pub answer: String,
    pub citations: Vec<MeetingCitation>,
    pub relevancy_score: f32,
    pub relevancy_label: String,
    pub is_fallback: bool,
    pub recent_meetings: Option<Vec<RecentMeetingInfo>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageRecord {
    pub id: String,
    pub role: String,
    pub content: String,
    pub citations: Option<Vec<MeetingCitation>>,
    pub relevancy_label: Option<String>,
    pub relevancy_score: Option<f32>,
    pub created_at: String,
}

/// Real-time streaming events sent across the Tauri Channel
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatStreamEvent {
    Start {
        session_id: String,
        message_id: String,
    },
    Sources {
        citations: Vec<MeetingCitation>,
    },
    Token {
        token: String,
    },
    Done {
        answer: String,
        citations: Vec<MeetingCitation>,
        relevancy_score: f32,
        relevancy_label: String,
        is_fallback: bool,
    },
    Error {
        error: String,
    },
}

#[derive(Debug, Clone)]
pub struct RetrievedKnowledgeChunk {
    pub chunk_id: Uuid,
    pub project_id: Uuid,
    pub project_name: String,
    pub meeting_id: String,
    pub meeting_title: String,
    pub meeting_date: chrono::DateTime<Utc>,
    pub source_type: String,
    pub content: String,
    pub speakers: Vec<String>,
    pub start_seconds: Option<f64>,
    pub end_seconds: Option<f64>,
    pub chunk_index: i32,
    pub cosine_sim: f64,
    pub rrf_score: f64,
}

#[derive(Debug, Clone)]
struct RetrievedInsight {
    meeting_id: String,
    meeting_title: String,
    insight_type: String,
    content: String,
    owner_name: Option<String>,
}

/// Greeting check (Step 0) - immediate friendly response without DB latency
fn check_greeting(query: &str) -> Option<&'static str> {
    let clean = query.trim().trim_end_matches(&['?', '!', '.', ','][..]).to_lowercase();
    match clean.as_str() {
        "hi" | "hello" | "hey" | "good morning" | "good afternoon" | "good evening" => {
            Some("Hello! I am your CrestMeet AI Assistant. Ask me anything about your conducted meetings, decisions, action items, or specific topics discussed across your notes.")
        }
        "help" | "who are you" | "what can you do" => {
            Some("I can search and answer questions across all your meeting records! For example:\n• *\"What were the key decisions made this week?\"*\n• *\"List all my pending action items\"*\n• *\"What did we discuss about pricing or roadmap?\"*")
        }
        _ => None,
    }
}

/// Meeting-domain-aware keyword extractor
fn extract_search_keywords(query: &str) -> Vec<String> {
    let stop_words: HashSet<&'static str> = [
        "the", "a", "an", "in", "on", "at", "to", "for", "of", "with",
        "is", "was", "are", "were", "be", "been", "being",
        "it", "this", "that", "these", "those",
        "can", "could", "would", "will", "should",
        "please", "just", "also", "very", "really",
        "what", "when", "where", "how", "who", "which",
    ]
    .iter()
    .cloned()
    .collect();

    query
        .split_whitespace()
        .map(|w| {
            w.trim_matches(|c: char| !char::is_alphanumeric(c))
                .to_lowercase()
        })
        .filter(|w| w.len() > 2 && !stop_words.contains(w.as_str()))
        .collect()
}

/// Query local Python RAG microservice for query vector (FastEmbed ONNX)
async fn fetch_query_embedding_local(query: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(600))
        .build()
        .ok()?;

    let res = client
        .post("http://127.0.0.1:8123/embed")
        .json(&serde_json::json!({ "texts": [query] }))
        .send()
        .await
        .ok()?;

    if !res.status().is_success() {
        return None;
    }

    let val: serde_json::Value = res.json().await.ok()?;
    let vec_arr = val.get("embeddings")?.as_array()?.first()?.as_array()?;
    let coords: Vec<String> = vec_arr
        .iter()
        .filter_map(|v| v.as_f64().map(|f| f.to_string()))
        .collect();

    if coords.len() == 384 {
        Some(format!("[{}]", coords.join(",")))
    } else {
        None
    }
}

/// Detect if a query is purely generic overview/status (Path A) vs specific search (Path B)
/// Uses entity subtraction: if ANY substantive topic, entity, feature or person name is present,
/// this immediately returns false -> routes to Path B (Specific Search).
fn is_purely_generic_query(query: &str) -> bool {
    let q = query.trim().to_lowercase();

    // Remove punctuation to isolate tokens
    let cleaned: String = q
        .chars()
        .map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' })
        .collect();
    let words: Vec<&str> = cleaned.split_whitespace().collect();

    // Universal stop words, meta question words, and generic meeting status nouns
    let stop_words: std::collections::HashSet<&str> = [
        "what", "whats", "what's", "are", "is", "were", "was", "all", "the", "a", "an",
        "my", "our", "your", "their", "any", "some", "pending", "action", "item", "items",
        "task", "tasks", "assigned", "who", "responsible", "for", "each", "key",
        "decision", "decisions", "recent", "recently", "latest", "last", "few", "past",
        "meeting", "meetings", "call", "calls", "discussion", "discussions", "summarize",
        "summary", "give", "me", "an", "overview", "of", "and", "in", "progress",
        "blockers", "updates", "update", "milestones", "milestone", "deadlines", "deadline",
        "timeline", "timelines", "scheduled", "targets", "target", "cross", "themes",
        "theme", "recap", "takeaways", "takeaway", "highlights", "highlight", "weekly",
        "today", "yesterday", "we", "did", "have", "tell", "about", "show", "list",
        "notes", "note", "status", "report", "brief", "agenda", "minutes", "from", "to",
        "with", "on", "at", "by", "do", "done", "does", "get", "got", "can", "could",
        "would", "should", "there", "here", "work", "going", "decide", "decided",
        "discuss", "discussed", "talking", "talk", "talked", "mentioned"
    ]
    .iter()
    .cloned()
    .collect();

    // Check if any specific domain/topic words remain
    let remaining_substantive: Vec<&str> = words
        .into_iter()
        .filter(|w| !stop_words.contains(w) && w.len() > 2)
        .collect();

    // If substantive words remain (e.g. "pricing", "auth", "alex", "stripe", "database"),
    // then this is NOT purely generic -> Route to Path B (Specific Search)!
    if !remaining_substantive.is_empty() {
        return false;
    }

    // Check if query contains any overview/action/decision intent keywords
    let has_overview_intent = q.contains("action")
        || q.contains("task")
        || q.contains("decision")
        || q.contains("deadline")
        || q.contains("milestone")
        || q.contains("overview")
        || q.contains("summar")
        || q.contains("recap")
        || q.contains("progress")
        || q.contains("update")
        || q.contains("takeaway")
        || q.contains("highlight")
        || q.contains("meeting")
        || q.contains("discuss");

    has_overview_intent
}


#[derive(Debug, Clone)]
pub struct ScopedMeetingItem {
    pub id: String,
    pub title: String,
    pub project_id: Uuid,
    pub project_name: String,
    pub created_at: chrono::DateTime<Utc>,
}

/// Fetch latest meetings (in recording order created_at DESC) scoped to user's assigned projects or specific project selection
async fn fetch_latest_meetings_for_scope(
    pool: &PgPool,
    user_id: Option<Uuid>,
    project_ids: Option<&[Uuid]>,
    limit: i64,
) -> Vec<ScopedMeetingItem> {
    let rows = sqlx::query_as::<_, (String, String, Uuid, String, chrono::DateTime<Utc>)>(
        r#"
        WITH allowed_projects AS (
            SELECT project_id, project_name FROM resolve_scope($1, $2)
        ),
        user_personal AS (
            SELECT id AS project_id, name AS project_name FROM projects WHERE is_personal = true AND created_by = $2 LIMIT 1
        )
        SELECT m.id, m.title,
               COALESCE(m.project_id, up.project_id, '00000000-0000-0000-0000-000000000000'::uuid) AS project_id,
               COALESCE(ap.project_name, up.project_name, 'Personal') AS project_name,
               COALESCE(m.created_at, NOW()) AS created_at
        FROM meetings m
        LEFT JOIN allowed_projects ap ON ap.project_id = m.project_id
        LEFT JOIN user_personal up ON true
        WHERE (
            m.project_id IN (SELECT project_id FROM allowed_projects)
            OR ($1 IS NULL AND m.user_id = $2 AND m.project_id IS NULL)
        )
        ORDER BY m.created_at DESC
        LIMIT $3
        "#,
    )
    .bind(project_ids)
    .bind(user_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    rows.into_iter()
        .map(|(id, title, project_id, project_name, created_at)| ScopedMeetingItem {
            id,
            title,
            project_id,
            project_name,
            created_at,
        })
        .collect()
}

/// Fetch representative chunks (summaries and top transcript chunks) for the given meeting IDs
async fn fetch_representative_chunks_for_meetings(
    pool: &PgPool,
    meeting_ids: &[String],
    chunks_per_meeting: i64,
) -> Vec<RetrievedKnowledgeChunk> {
    if meeting_ids.is_empty() {
        return Vec::new();
    }

    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            Uuid,
            String,
            String,
            String,
            chrono::DateTime<Utc>,
            String,
            String,
            Vec<String>,
            Option<f64>,
            Option<f64>,
            i32,
        ),
    >(
        r#"
        WITH ranked_chunks AS (
            SELECT c.id AS chunk_id,
                   c.project_id,
                   COALESCE(p.name, 'Personal') AS project_name,
                   c.meeting_id,
                   m.title AS meeting_title,
                   COALESCE(m.created_at, NOW()) AS meeting_date,
                   c.source_type,
                   c.content,
                   c.speakers,
                   c.start_seconds,
                   c.end_seconds,
                   c.chunk_index,
                   ROW_NUMBER() OVER (
                       PARTITION BY c.meeting_id
                       ORDER BY 
                           CASE WHEN c.source_type = 'summary' THEN 0 ELSE 1 END,
                           c.chunk_index ASC
                   ) AS rn
            FROM knowledge_chunks c
            JOIN meetings m ON m.id = c.meeting_id
            LEFT JOIN projects p ON p.id = c.project_id
            WHERE c.meeting_id = ANY($1)
        )
        SELECT chunk_id, project_id, project_name, meeting_id, meeting_title, meeting_date,
               source_type, content, speakers, start_seconds, end_seconds, chunk_index
        FROM ranked_chunks
        WHERE rn <= $2
        ORDER BY meeting_date DESC, rn ASC
        "#,
    )
    .bind(meeting_ids)
    .bind(chunks_per_meeting)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    rows.into_iter()
        .map(|r| RetrievedKnowledgeChunk {
            chunk_id: r.0,
            project_id: r.1,
            project_name: r.2,
            meeting_id: r.3,
            meeting_title: r.4,
            meeting_date: r.5,
            source_type: r.6,
            content: r.7,
            speakers: r.8,
            start_seconds: r.9,
            end_seconds: r.10,
            chunk_index: r.11,
            cosine_sim: 1.0,
            rrf_score: 1.0,
        })
        .collect()
}

/// Execute pgvector + FTS hybrid search using PostgreSQL RPC `search_knowledge`
async fn search_knowledge_chunks(
    pool: &PgPool,
    project_ids: Option<&[Uuid]>,
    keywords: &[String],
    query_vector_str: Option<&str>,
    user_id: Option<Uuid>,
    match_count: i32,
    meeting_ids: Option<&[String]>,
) -> Vec<RetrievedKnowledgeChunk> {
    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            Uuid,
            String,
            String,
            String,
            chrono::DateTime<Utc>,
            String,
            String,
            Vec<String>,
            Option<f64>,
            Option<f64>,
            i32,
            f64,
            i32,
            i32,
            f64,
        ),
    >(
        r#"
        SELECT chunk_id, project_id, project_name, meeting_id, meeting_title, meeting_date,
               source_type, content, speakers, start_seconds, end_seconds, chunk_index,
               cosine_sim, vector_rank, text_rank, rrf_score
        FROM search_knowledge($1, $2, CAST($3 AS vector), $4, $5, $6)
        "#,
    )
    .bind(project_ids)
    .bind(keywords)
    .bind(query_vector_str)
    .bind(user_id)
    .bind(match_count)
    .bind(meeting_ids)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    rows.into_iter()
        .map(|r| RetrievedKnowledgeChunk {
            chunk_id: r.0,
            project_id: r.1,
            project_name: r.2,
            meeting_id: r.3,
            meeting_title: r.4,
            meeting_date: r.5,
            source_type: r.6,
            content: r.7,
            speakers: r.8,
            start_seconds: r.9,
            end_seconds: r.10,
            chunk_index: r.11,
            cosine_sim: r.12,
            rrf_score: r.15,
        })
        .collect()
}

/// Fetch project-scoped decisions and action items from `meeting_insights`
async fn fetch_scoped_insights(
    pool: &PgPool,
    project_ids: Option<&[Uuid]>,
    user_id: Option<Uuid>,
    meeting_ids: Option<&[String]>,
    limit: i64,
) -> Vec<RetrievedInsight> {
    let rows = sqlx::query_as::<_, (String, String, String, String, Option<String>)>(
        r#"
        SELECT mi.meeting_id, m.title, mi.type, mi.content, mi.owner_name
        FROM meeting_insights mi
        JOIN meetings m ON m.id = mi.meeting_id
        WHERE ($1::uuid[] IS NULL OR mi.project_id = ANY($1))
          AND ($2::uuid IS NULL OR m.user_id = $2)
          AND ($3::text[] IS NULL OR mi.meeting_id = ANY($3))
        ORDER BY m.created_at DESC, mi.created_at DESC
        LIMIT $4
        "#,
    )
    .bind(project_ids)
    .bind(user_id)
    .bind(meeting_ids)
    .bind(limit)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    rows.into_iter()
        .map(|(meeting_id, meeting_title, insight_type, content, owner_name)| {
            RetrievedInsight {
                meeting_id,
                meeting_title,
                insight_type,
                content,
                owner_name,
            }
        })
        .collect()
}

/// Fetch recent meetings for fallback listing
async fn fetch_recent_meetings(
    pool: &PgPool,
    user_id: Option<Uuid>,
    project_ids: Option<&[Uuid]>,
) -> Vec<RecentMeetingInfo> {
    let rows = sqlx::query_as::<_, (String, String, chrono::DateTime<Utc>)>(
        r#"
        SELECT id, title, created_at
        FROM meetings
        WHERE ($1::uuid IS NULL OR user_id = $1)
          AND ($2::uuid[] IS NULL OR project_id = ANY($2))
        ORDER BY created_at DESC
        LIMIT 5
        "#,
    )
    .bind(user_id)
    .bind(project_ids)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    rows.into_iter()
        .map(|(id, title, dt)| RecentMeetingInfo {
            id,
            title,
            date: dt.format("%Y-%m-%d").to_string(),
        })
        .collect()
}

/// Strip raw [S#] citations from past assistant turns to avoid label collisions
fn strip_source_tags(text: &str) -> String {
    let re = regex::Regex::new(r"\[S\d+\]").ok();
    if let Some(r) = re {
        r.replace_all(text, "").to_string()
    } else {
        text.to_string()
    }
}

#[derive(Debug, Clone)]
pub struct ConversationMemory {
    pub anchored_intent: Option<String>,
    pub rolling_summary: Option<String>,
    pub recent_turns: Vec<(String, String)>,
    pub total_prior_messages: i32,
}

/// Load conversation memory: rolling summary, anchored initial intent, and recent 6 turns
async fn load_conversation_memory(
    pool: &PgPool,
    session_id: &str,
    current_user: Option<Uuid>,
) -> ConversationMemory {
    let s_uuid = Uuid::parse_str(session_id).ok();
    let session_row = if let Some(sid) = s_uuid {
        sqlx::query_as::<_, (Option<String>, i32)>(
            "SELECT summary, message_count FROM chat_sessions WHERE id = $1",
        )
        .bind(sid)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
    } else {
        None
    };

    let (rolling_summary, total_prior_messages) = match session_row {
        Some((sum, count)) => (sum, count),
        None => (None, 0),
    };

    let msg_rows = if let Some(uid) = current_user {
        sqlx::query_as::<_, (String, String)>(
            r#"
            SELECT role, content
            FROM chat_messages
            WHERE user_id = $1 AND (chat_session_id = $2 OR session_id::text = $2)
            ORDER BY created_at ASC
            LIMIT 25
            "#,
        )
        .bind(uid)
        .bind(session_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
    } else {
        sqlx::query_as::<_, (String, String)>(
            r#"
            SELECT role, content
            FROM chat_messages
            WHERE chat_session_id = $1 OR session_id::text = $1
            ORDER BY created_at ASC
            LIMIT 25
            "#,
        )
        .bind(session_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
    };

    let anchored_intent = msg_rows
        .iter()
        .find(|(role, _)| role == "user")
        .map(|(_, content)| content.clone());

    let recent_len = msg_rows.len();
    let start_idx = if recent_len > 4 { recent_len - 4 } else { 0 };
    let recent_turns: Vec<(String, String)> = msg_rows[start_idx..]
        .iter()
        .map(|(role, content)| {
            let sanitized = if role == "assistant" {
                strip_source_tags(content)
            } else {
                content.clone()
            };
            (role.clone(), sanitized)
        })
        .collect();

    ConversationMemory {
        anchored_intent,
        rolling_summary,
        recent_turns,
        total_prior_messages,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryIntent {
    GeneralOverview,
    SpecificSearch,
}

#[derive(Debug, Clone)]
pub struct QueryAnalysis {
    pub intent: QueryIntent,
    pub search_query: String,
}

/// Intelligently classify query intent and rewrite follow-up queries using Groq in a single fast call
async fn analyze_and_rewrite_query(
    api_key: &str,
    model_name: &str,
    query: &str,
    memory: &ConversationMemory,
) -> QueryAnalysis {
    let fallback_intent = if is_purely_generic_query(query) {
        QueryIntent::GeneralOverview
    } else {
        QueryIntent::SpecificSearch
    };

    let mut recent_snippet = String::new();
    let len = memory.recent_turns.len();
    let slice_start = if len > 4 { len - 4 } else { 0 };
    for (role, text) in &memory.recent_turns[slice_start..] {
        let prefix = if role == "user" { "User" } else { "Assistant" };
        let excerpt: String = text.chars().take(220).collect();
        recent_snippet.push_str(&format!("{}: {}\n", prefix, excerpt));
    }

    let prompt = format!(
        r#"Analyze this meeting chatbot question and output ONLY a valid JSON object.

Recent Conversation History:
{}

User Question: "{}"

Task:
1. Determine "intent":
   - "general_overview": The user is asking a broad, cross-meeting status question with NO specific entity or project (e.g. "What are my pending action items?", "Summarize recent meetings", "What are our recent key decisions?", "Cross-meeting overview", "Recent updates").
   - "specific_search": The user is asking about a specific topic, feature, entity, meeting, or person (e.g. "What did we decide about pricing?", "Postgres migration blockers", "Who worked on auth?"), OR asking a follow-up that refers to a specific entity from conversation history (e.g. "What are the tasks for it?").

2. Provide "search_query":
   - If specific_search: Rewrite into a standalone keyword/semantic search query resolving any pronouns or conversational references.
   - If general_overview: Keep the core query concise.

Output ONLY this raw JSON format (no markdown, no quotes around JSON):
{{"intent": "general_overview" | "specific_search", "search_query": "..."}}"#,
        if recent_snippet.is_empty() { "(No prior conversation)" } else { &recent_snippet },
        query
    );

    let res = call_groq_synthesize(
        api_key,
        model_name,
        "You are an expert search classifier and query rewriter. Output ONLY raw JSON.",
        &prompt,
    )
    .await;

    if let Ok(raw_json) = res {
        let clean = raw_json
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();

        if let Ok(val) = serde_json::from_str::<serde_json::Value>(clean) {
            let intent = match val.get("intent").and_then(|i| i.as_str()) {
                Some("general_overview") => QueryIntent::GeneralOverview,
                Some("specific_search") => QueryIntent::SpecificSearch,
                _ => fallback_intent.clone(),
            };
            let search_query = val
                .get("search_query")
                .and_then(|s| s.as_str())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(query)
                .to_string();

            info!(
                "[Chatbot Router LLM] Intent: {:?}, Search Query: '{}'",
                intent, search_query
            );

            return QueryAnalysis {
                intent,
                search_query,
            };
        }
    }

    // Fallback if LLM call fails
    info!("[Chatbot Router] Fallback to code logic: {:?}", fallback_intent);
    QueryAnalysis {
        intent: fallback_intent,
        search_query: query.to_string(),
    }
}

/// Extract verified citations from answer referencing either [S#] or [[meeting_id: Title]]
fn extract_verified_citations(
    answer: &str,
    chunks: &[RetrievedKnowledgeChunk],
) -> Vec<MeetingCitation> {
    let mut citations = Vec::new();
    let mut seen_keys = HashSet::new();

    // 1. Check numeric source markers [S1], [S2]...
    for (idx, c) in chunks.iter().enumerate() {
        let tag = format!("[S{}]", idx + 1);
        if answer.contains(&tag) {
            let sec_key = c.start_seconds.map(|s| s.round() as i64);
            let key = (c.meeting_id.clone(), sec_key);
            if !seen_keys.contains(&key) {
                seen_keys.insert(key);
                citations.push(MeetingCitation {
                    label: Some(format!("S{}", idx + 1)),
                    meeting_id: c.meeting_id.clone(),
                    meeting_title: c.meeting_title.clone(),
                    date: c.meeting_date.format("%Y-%m-%d").to_string(),
                    snippet: Some(c.content.chars().take(160).collect()),
                    start_seconds: c.start_seconds,
                    end_seconds: c.end_seconds,
                    speaker: c.speakers.first().cloned(),
                    project_name: Some(c.project_name.clone()),
                    chunk_id: Some(c.chunk_id.to_string()),
                });
            }
        }
    }

    // 2. Check legacy tag syntax [[meeting_id: Meeting Title]]
    let mut cursor = answer;
    while let Some(start) = cursor.find("[[") {
        if let Some(end) = cursor[start..].find("]]") {
            let inside = &cursor[start + 2..start + end];
            let parts: Vec<&str> = inside.splitn(2, ':').collect();
            if parts.len() == 2 {
                let id = parts[0].trim().to_string();
                let title = parts[1].trim().to_string();

                let key = (id.clone(), None);
                if !seen_keys.contains(&key) {
                    seen_keys.insert(key);
                    let matched_chunk = chunks.iter().find(|c| c.meeting_id == id);
                    let date = matched_chunk
                        .map(|c| c.meeting_date.format("%Y-%m-%d").to_string())
                        .unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string());

                    citations.push(MeetingCitation {
                        label: None,
                        meeting_id: id,
                        meeting_title: title,
                        date,
                        snippet: matched_chunk.map(|c| c.content.chars().take(160).collect()),
                        start_seconds: matched_chunk.and_then(|c| c.start_seconds),
                        end_seconds: matched_chunk.and_then(|c| c.end_seconds),
                        speaker: matched_chunk.and_then(|c| c.speakers.first().cloned()),
                        project_name: matched_chunk.map(|c| c.project_name.clone()),
                        chunk_id: matched_chunk.map(|c| c.chunk_id.to_string()),
                    });
                }
            }
            cursor = &cursor[start + end + 2..];
        } else {
            break;
        }
    }

    citations
}

/// Clean citation brackets from answer for smooth reading
fn clean_answer_citations(answer: &str) -> String {
    let mut cleaned = String::with_capacity(answer.len());
    let mut cursor = answer;
    while let Some(start) = cursor.find("[[") {
        cleaned.push_str(&cursor[..start]);
        if let Some(end) = cursor[start..].find("]]") {
            let inside = &cursor[start + 2..start + end];
            let parts: Vec<&str> = inside.splitn(2, ':').collect();
            if parts.len() == 2 {
                let title = parts[1].trim();
                cleaned.push_str(&format!("**{}**", title));
            } else {
                cleaned.push_str(inside);
            }
            cursor = &cursor[start + end + 2..];
        } else {
            cleaned.push_str(&cursor[start..]);
            break;
        }
    }
    cleaned.push_str(cursor);
    cleaned
}

/// Extract `@project:"name"` or `@project:name` from query string and return matched names + cleaned query
fn extract_project_tags_from_query(query: &str) -> (Vec<String>, String) {
    let re = match regex::Regex::new(r#"(?i)@project:(?:"([^"]+)"|(\S+))"#) {
        Ok(r) => r,
        Err(_) => return (Vec::new(), query.to_string()),
    };
    let mut project_names = Vec::new();
    for cap in re.captures_iter(query) {
        if let Some(m) = cap.get(1).or_else(|| cap.get(2)) {
            let name = m.as_str().trim();
            if !name.is_empty() {
                project_names.push(name.to_string());
            }
        }
    }
    let cleaned = re.replace_all(query, "").trim().to_string();
    (project_names, cleaned)
}

/// Dynamically resolve target project scope based on:
/// 1. Project IDs explicitly passed from UI composer pill (if any)
/// 2. Project tags typed inline in the query (`@project:name`)
/// 3. Authenticated user's memberships (strict access control)
async fn resolve_effective_project_scope(
    pool: &PgPool,
    chat_session_id: &str,
    current_user: Option<Uuid>,
    explicit_project_ids: Option<Vec<Uuid>>,
    mentioned_project_names: &[String],
) -> (Option<Vec<Uuid>>, Vec<String>) {
    let uid = match current_user {
        Some(u) => u,
        None => return (None, vec!["All Projects (Unauthenticated)".to_string()]),
    };

    // 1. Fetch all assigned unarchived projects for this authenticated user
    let user_projects = sqlx::query_as::<_, (Uuid, String)>(
        r#"
        SELECT p.id, p.name 
        FROM project_members pm
        JOIN projects p ON p.id = pm.project_id
        WHERE pm.user_id = $1 AND p.is_archived = false
        "#,
    )
    .bind(uid)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    if user_projects.is_empty() {
        return (None, vec!["No Assigned Projects".to_string()]);
    }

    let mut target_ids: HashSet<Uuid> = HashSet::new();

    // 2. Add explicit project IDs from UI pill (validated against user's assigned projects)
    if let Some(pids) = explicit_project_ids {
        for pid in pids {
            if user_projects.iter().any(|(id, _)| *id == pid) {
                target_ids.insert(pid);
            }
        }
    }

    // 3. Add any projects mentioned via `@project:name`
    for name in mentioned_project_names {
        let clean_name = name.trim().to_lowercase();
        if clean_name == "all" || clean_name == "all projects" {
            // User explicitly requested all projects via tag
            target_ids.clear();
            break;
        }
        for (id, pname) in &user_projects {
            if pname.trim().to_lowercase() == clean_name {
                target_ids.insert(*id);
            }
        }
    }

    if !target_ids.is_empty() {
        let ids: Vec<Uuid> = target_ids.into_iter().collect();
        let names: Vec<String> = user_projects
            .iter()
            .filter(|(id, _)| ids.contains(id))
            .map(|(_, name)| name.clone())
            .collect();

        // Update chat session with this active scope
        let _ = sqlx::query(
            "UPDATE chat_sessions SET scope_project_ids = $1, updated_at = NOW() WHERE id::text = $2",
        )
        .bind(&ids)
        .bind(chat_session_id)
        .execute(pool)
        .await;

        (Some(ids), names)
    } else {
        // "All Projects" (all projects assigned to the authenticated user)
        let all_names: Vec<String> = user_projects.iter().map(|(_, name)| name.clone()).collect();
        let _ = sqlx::query(
            "UPDATE chat_sessions SET scope_project_ids = NULL, updated_at = NOW() WHERE id::text = $1",
        )
        .bind(chat_session_id)
        .execute(pool)
        .await;

        (None, all_names)
    }
}

/// Stream answer from Groq API via SSE (Server-Sent Events)
async fn call_groq_synthesize_stream<F>(
    api_key: &str,
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    mut on_token: F,
) -> Result<String, String>
where
    F: FnMut(String) -> (),
{
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key))
            .map_err(|_| "Invalid Groq API key format".to_string())?,
    );
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    let payload = json!({
        "model": model_name,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
        "temperature": 0.2,
        "max_tokens": 1500,
        "stream": true
    });

    let res = {
        let first_res = client
            .post("https://api.groq.com/openai/v1/chat/completions")
            .headers(headers.clone())
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("Network request to Groq failed: {}", e))?;

        if first_res.status().as_u16() == 429 && model_name != "llama-3.3-70b-versatile" {
            warn!(
                "Groq rate limit (429) hit on model '{}'. Retrying seamlessly with 'llama-3.3-70b-versatile'...",
                model_name
            );
            let mut retry_payload = payload.clone();
            retry_payload["model"] = json!("llama-3.3-70b-versatile");
            client
                .post("https://api.groq.com/openai/v1/chat/completions")
                .headers(headers)
                .json(&retry_payload)
                .send()
                .await
                .map_err(|e| format!("Fallback network request to Groq failed: {}", e))?
        } else {
            first_res
        }
    };

    if !res.status().is_success() {
        let err_text = res.text().await.unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("Groq API error: {}", err_text));
    }

    let mut stream = res.bytes_stream();
    let mut buffer = String::new();
    let mut full_answer = String::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Stream error: {}", e))?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.starts_with("data: ") {
                let data = &line[6..].trim();
                if *data == "[DONE]" {
                    break;
                }
                if let Ok(v) = serde_json::from_str::<Value>(data) {
                    if let Some(token) = v["choices"][0]["delta"]["content"].as_str() {
                        full_answer.push_str(token);
                        on_token(token.to_string());
                    }
                }
            }
        }
    }

    Ok(full_answer)
}

/// Synthesize non-streaming answer using Groq API
async fn call_groq_synthesize(
    api_key: &str,
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, String> {
    call_groq_synthesize_stream(api_key, model_name, system_prompt, user_prompt, |_| {}).await
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Send message to the Meeting Chatbot with Live Token Streaming
#[tauri::command]
pub async fn api_chat_send_message_stream(
    state: State<'_, AppState>,
    query: String,
    chat_session_id: String,
    project_ids: Option<Vec<String>>,
    on_event: Channel<ChatStreamEvent>,
) -> Result<(), String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        let _ = on_event.send(ChatStreamEvent::Error {
            error: "Question cannot be empty".to_string(),
        });
        return Err("Question cannot be empty".to_string());
    }

    let pool = state.db_manager.pool().clone();
    let current_user = *state.current_user_id.read().await;

    // Send start event
    let user_msg_id = format!("msg-{}", Uuid::new_v4());
    let ast_msg_id = format!("msg-{}", Uuid::new_v4());
    let _ = on_event.send(ChatStreamEvent::Start {
        session_id: chat_session_id.clone(),
        message_id: ast_msg_id.clone(),
    });

    // Step 0: Check greetings for instant response
    if let Some(greeting_reply) = check_greeting(&q) {
        let _ = sqlx::query(
            "INSERT INTO chat_messages (id, user_id, chat_session_id, role, content, citations) VALUES ($1, $2, $3, 'user', $4, NULL), ($5, $2, $3, 'assistant', $6, NULL)"
        )
        .bind(&user_msg_id)
        .bind(current_user)
        .bind(&chat_session_id)
        .bind(&q)
        .bind(&ast_msg_id)
        .bind(greeting_reply)
        .execute(&pool)
        .await;

        let _ = on_event.send(ChatStreamEvent::Token {
            token: greeting_reply.to_string(),
        });
        let _ = on_event.send(ChatStreamEvent::Done {
            answer: greeting_reply.to_string(),
            citations: Vec::new(),
            relevancy_score: 1.0,
            relevancy_label: "Direct Greeting".to_string(),
            is_fallback: false,
        });

        return Ok(());
    }

    // Step 1: Check Groq API Key
    let model_config = SettingsRepository::get_model_config_for_user(&pool, current_user)
        .await
        .map_err(|e| format!("Failed to read settings: {}", e))?;

    let groq_api_key = model_config
        .as_ref()
        .and_then(|c| c.groq_api_key.clone())
        .or_else(|| std::env::var("GROQ_API_KEY").ok())
        .filter(|k| !k.trim().is_empty());

    let api_key = match groq_api_key {
        Some(k) => k,
        None => {
            let err_msg = "Groq API Key is not configured. Please open Settings -> AI Model and enter your Groq API Key to enable the meeting chatbot.".to_string();
            let _ = on_event.send(ChatStreamEvent::Error { error: err_msg.clone() });
            return Err(err_msg);
        }
    };

    // Step 2: Extract @project: tags from query & resolve effective project scope
    let (mentioned_project_names, cleaned_user_query) = extract_project_tags_from_query(&q);
    let explicit_uuids = project_ids.map(|ids| {
        ids.into_iter()
            .filter_map(|s| Uuid::parse_str(&s).ok())
            .collect::<Vec<Uuid>>()
    });

    let (project_scope, target_project_names) = resolve_effective_project_scope(
        &pool,
        &chat_session_id,
        current_user,
        explicit_uuids,
        &mentioned_project_names,
    )
    .await;

    // Step 3: Load Multi-Turn Conversation Memory & Target Model
    let target_model = model_config
        .as_ref()
        .map(|c| c.model.trim())
        .filter(|m| !m.is_empty() && !m.contains("whisper") && !m.contains("llama"))
        .unwrap_or("openai/gpt-oss-120b");

    let memory = load_conversation_memory(&pool, &chat_session_id, current_user).await;

    // Step 4: Intelligent Query Analysis & Routing (Intent + Search Query in a single fast call)
    let query_to_analyze = if cleaned_user_query.is_empty() { &q } else { &cleaned_user_query };
    let analysis = analyze_and_rewrite_query(&api_key, target_model, query_to_analyze, &memory).await;

    let (latest_scoped_meetings, search_query, query_vector_str, chunks, insights) = match analysis.intent {
        QueryIntent::GeneralOverview => {
            // =========================================================================
            // PATH A: Purely Generic Overview / Cross-Meeting Status
            // =========================================================================
            let meetings = fetch_latest_meetings_for_scope(&pool, current_user, project_scope.as_deref(), 5).await;
            if meetings.is_empty() {
                let no_meetings_msg = "You don't have any recorded meetings in your accessible project scope yet. Once you record or import meetings, I can analyze action items, decisions, and summaries for you!".to_string();
                let _ = on_event.send(ChatStreamEvent::Token { token: no_meetings_msg.clone() });
                let _ = on_event.send(ChatStreamEvent::Done {
                    answer: no_meetings_msg.clone(),
                    citations: Vec::new(),
                    relevancy_score: 0.0,
                    relevancy_label: "No Meetings Found".to_string(),
                    is_fallback: true,
                });

                let _ = sqlx::query(
                    "INSERT INTO chat_messages (id, user_id, chat_session_id, role, content, citations) VALUES ($1, $2, $3, 'user', $4, NULL), ($5, $2, $3, 'assistant', $6, NULL)"
                )
                .bind(&user_msg_id)
                .bind(current_user)
                .bind(&chat_session_id)
                .bind(&q)
                .bind(&ast_msg_id)
                .bind(&no_meetings_msg)
                .execute(&pool)
                .await;

                return Ok(());
            }

            let m_ids: Vec<String> = meetings.iter().map(|m| m.id.clone()).collect();
            // Fetch 1 summary chunk per meeting (5 chunks max)
            let chs = fetch_representative_chunks_for_meetings(&pool, &m_ids, 1).await;
            // Fetch up to 8 action items / decisions from these meetings
            let ins = fetch_scoped_insights(&pool, project_scope.as_deref(), current_user, Some(&m_ids), 8).await;

            (meetings, analysis.search_query, None, chs, ins)
        }
        QueryIntent::SpecificSearch => {
            // =========================================================================
            // PATH B: Specific Topic / Keyword Search (Hybrid Vector + FTS RRF)
            // =========================================================================
            let rewritten_query = analysis.search_query;
            let keywords = extract_search_keywords(&rewritten_query);
            let q_vec = fetch_query_embedding_local(&rewritten_query).await;

            // Fetch top 6 chunks across the scope via Hybrid RRF search
            let chs = search_knowledge_chunks(
                &pool,
                project_scope.as_deref(),
                &keywords,
                q_vec.as_deref(),
                current_user,
                6,
                None,
            )
            .await;

            // Fetch up to 6 project-scoped insights
            let ins = fetch_scoped_insights(&pool, project_scope.as_deref(), current_user, None, 6).await;

            (Vec::new(), rewritten_query, q_vec, chs, ins)
        }
    };

    // Terminal Logging for visibility
    let mut chunk_project_map: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for c in &chunks {
        *chunk_project_map.entry(c.project_name.clone()).or_insert(0) += 1;
    }

    info!("==================== [Chatbot Query] ====================");
    info!("[Chatbot] Session ID    : {}", chat_session_id);
    info!("[Chatbot] Raw Question  : \"{}\"", q);
    if !cleaned_user_query.is_empty() && cleaned_user_query != q {
        info!("[Chatbot] Cleaned Query : \"{}\"", cleaned_user_query);
    }
    info!("[Chatbot] Search Query  : \"{}\"", search_query);
    info!(
        "[Chatbot] Target Scope  : {:?} (IDs: {:?})",
        target_project_names,
        project_scope
    );
    info!(
        "[Chatbot] Query Mode    : {:?}",
        analysis.intent
    );
    if !latest_scoped_meetings.is_empty() {
        let meeting_labels: Vec<String> = latest_scoped_meetings
            .iter()
            .map(|m| format!("\"{}\" [{}] ({})", m.title, m.project_name, m.created_at.format("%Y-%m-%d")))
            .collect();
        info!("[Chatbot] Latest 5 Mtgs : {:?}", meeting_labels);
    }
    info!(
        "[Chatbot] Embedding     : {}",
        if query_vector_str.is_some() {
            "FastEmbed 384d Local OK (127.0.0.1:8123)"
        } else {
            "Local FastEmbed OFFLINE -> Falling back to PostgreSQL Keyword FTS"
        }
    );
    info!(
        "[Chatbot] Chunks Found  : {} across projects: {:?}",
        chunks.len(),
        chunk_project_map
    );
    info!("=========================================================");

    // Send preliminary sources
    let preliminary_sources: Vec<MeetingCitation> = chunks
        .iter()
        .take(6)
        .enumerate()
        .map(|(idx, c)| MeetingCitation {
            label: Some(format!("S{}", idx + 1)),
            meeting_id: c.meeting_id.clone(),
            meeting_title: c.meeting_title.clone(),
            date: c.meeting_date.format("%Y-%m-%d").to_string(),
            snippet: Some(c.content.chars().take(140).collect()),
            start_seconds: c.start_seconds,
            end_seconds: c.end_seconds,
            speaker: c.speakers.first().cloned(),
            project_name: Some(c.project_name.clone()),
            chunk_id: Some(c.chunk_id.to_string()),
        })
        .collect();

    let _ = on_event.send(ChatStreamEvent::Sources {
        citations: preliminary_sources,
    });

    if chunks.is_empty() && insights.is_empty() {
        let no_data_reply = "I couldn't find any relevant discussions or records for this question in your selected project scope. Feel free to rephrase or mention another project (e.g. `@project:ProjectName`)!".to_string();
        let _ = on_event.send(ChatStreamEvent::Token { token: no_data_reply.clone() });
        let _ = on_event.send(ChatStreamEvent::Done {
            answer: no_data_reply.clone(),
            citations: Vec::new(),
            relevancy_score: 0.0,
            relevancy_label: "No Relevant Records".to_string(),
            is_fallback: true,
        });

        // Store messages
        let _ = sqlx::query(
            "INSERT INTO chat_messages (id, user_id, chat_session_id, role, content, citations) VALUES ($1, $2, $3, 'user', $4, NULL), ($5, $2, $3, 'assistant', $6, NULL)"
        )
        .bind(&user_msg_id)
        .bind(current_user)
        .bind(&chat_session_id)
        .bind(&q)
        .bind(&ast_msg_id)
        .bind(&no_data_reply)
        .execute(&pool)
        .await;

        return Ok(());
    }

    // Step 7: Construct Synthesis Context with Multi-Turn Memory & Chunks
    let mut context_builder = String::new();

    // Multi-turn conversation memory integration
    if let Some(intent) = &memory.anchored_intent {
        context_builder.push_str(&format!("=== CONVERSATION TOPIC / ORIGINAL INTENT ===\n{}\n\n", intent));
    }

    if let Some(sum) = &memory.rolling_summary {
        context_builder.push_str(&format!("=== PRIOR CONVERSATION SUMMARY ===\n{}\n\n", sum));
    }

    if !memory.recent_turns.is_empty() {
        context_builder.push_str("=== RECENT CONVERSATION TURNS ===\n");
        for (role, text) in &memory.recent_turns {
            let label = if role == "user" { "User" } else { "Assistant" };
            context_builder.push_str(&format!("{}: {}\n", label, text.trim()));
        }
        context_builder.push_str("\n(Note: Prior assistant responses are for conversation continuity. Ground any factual claims about meetings exclusively in the RELEVANT MEETING KNOWLEDGE chunks below).\n\n");
    }

    if !latest_scoped_meetings.is_empty() {
        context_builder.push_str("=== LATEST RECORDED MEETINGS (CHRONOLOGICAL ORDER, NEWEST FIRST) ===\n");
        for (idx, m) in latest_scoped_meetings.iter().enumerate() {
            context_builder.push_str(&format!(
                "{}. \"{}\" [Project: {}] (Date: {}, ID: {})\n",
                idx + 1,
                m.title,
                m.project_name,
                m.created_at.format("%Y-%m-%d"),
                m.id
            ));
        }
        context_builder.push_str("\n(Note: The user asked a general/overview question. Focus your analysis and synthesis strictly across these latest recorded meetings in chronological order).\n\n");
    }

    if !chunks.is_empty() {
        context_builder.push_str("=== RELEVANT MEETING KNOWLEDGE & TRANSCRIPT CHUNKS ===\n");
        for (idx, c) in chunks.iter().enumerate() {
            let s_id = format!("S{}", idx + 1);
            let time_info = match (c.start_seconds, c.end_seconds) {
                (Some(s), Some(e)) => {
                    let sm = (s / 60.0).floor() as i32;
                    let ss = (s % 60.0).floor() as i32;
                    let em = (e / 60.0).floor() as i32;
                    let es = (e % 60.0).floor() as i32;
                    format!(" [{:02}:{:02}-{:02}:{:02}]", sm, ss, em, es)
                }
                _ => String::new(),
            };
            let speakers_info = if !c.speakers.is_empty() {
                format!(" (Speakers: {})", c.speakers.join(", "))
            } else {
                String::new()
            };
            context_builder.push_str(&format!(
                "[{}] [Project: {}] Meeting: \"{}\" (ID: {}, Date: {}{}{})\n{}\n\n",
                s_id,
                c.project_name,
                c.meeting_title,
                c.meeting_id,
                c.meeting_date.format("%Y-%m-%d"),
                time_info,
                speakers_info,
                c.content.trim()
            ));
        }
    }

    if !insights.is_empty() {
        context_builder.push_str("=== IDENTIFIED ACTION ITEMS & DECISIONS ===\n");
        for ins in &insights {
            let owner = ins
                .owner_name
                .as_deref()
                .map(|o| format!(" (Owner: {})", o))
                .unwrap_or_default();
            context_builder.push_str(&format!(
                "- [{}] from \"{}\" (ID: {}): {}{}\n",
                ins.insight_type.to_uppercase(),
                ins.meeting_title,
                ins.meeting_id,
                ins.content,
                owner
            ));
        }
        context_builder.push('\n');
    }

    // Step 8: System Instructions for Groq
    let system_prompt = r#"You are CrestMeet's AI Meeting Knowledge Assistant.
Answer the user's question accurately using ONLY the meeting records and excerpts provided in the context.
Rules:
1. When stating facts or conclusions from specific meetings, cite each source inline using [S#] or [[meeting_id: Meeting Title]]. For example: "The deployment was scheduled for Friday [S1] and pricing was capped at 15% [S2]."
2. If citing decisions or action items, state the owner and due date if available.
3. If the provided context does NOT contain enough information to answer the question, state clearly that you could not find this in their recorded meetings.
4. Keep answers clear, professional, concise, and structured with markdown bullet points.
5. If providing markdown tables, avoid raw HTML tags like <br>. Separate distinct items on separate rows or format them cleanly with bullet points.
6. When comparing or discussing multiple projects, clearly separate and identify which facts belong to which project. Use project names when contrasting decisions, architectures, or roadmaps.
7. For general overview, pending action items, recent decisions, or milestone queries, summarize strictly across the latest recorded meetings listed above in chronological order. Group or highlight discussions clearly by meeting and project."#;

    let user_prompt = format!(
        "Context Information:\n{}\n\nUser Question: {}",
        context_builder, q
    );

    info!(
        "Streaming Groq synthesis with model '{}' for chat query: '{}' with {} chunks",
        target_model,
        &q,
        chunks.len()
    );

    let event_sender = on_event.clone();
    let raw_answer = call_groq_synthesize_stream(
        &api_key,
        target_model,
        system_prompt,
        &user_prompt,
        move |token| {
            let _ = event_sender.send(ChatStreamEvent::Token { token });
        },
    )
    .await?;

    let citations = extract_verified_citations(&raw_answer, &chunks);
    let cleaned_answer = clean_answer_citations(&raw_answer);

    let is_empty_answer = raw_answer.to_lowercase().contains("could not find")
        || raw_answer.to_lowercase().contains("no information");

    let (relevancy_score, relevancy_label, is_fallback) = if is_empty_answer {
        (0.2, "Low Relevancy".to_string(), true)
    } else if citations.len() >= 2 {
        (
            0.95,
            format!("High Relevancy ({} Meetings Cited)", citations.len()),
            false,
        )
    } else if citations.len() == 1 {
        (0.85, "High Relevancy (1 Meeting Cited)".to_string(), false)
    } else {
        (0.70, "General Knowledge Match".to_string(), false)
    };

    // Save messages to database
    let citations_json = serde_json::to_string(&citations).ok();
    let session_uuid = Uuid::parse_str(&chat_session_id).ok();

    let _ = sqlx::query(
        r#"
        INSERT INTO chat_messages (id, user_id, chat_session_id, session_id, role, content, citations)
        VALUES ($1, $2, $3, $4, 'user', $5, NULL)
        "#,
    )
    .bind(&user_msg_id)
    .bind(current_user)
    .bind(&chat_session_id)
    .bind(session_uuid)
    .bind(&q)
    .execute(&pool)
    .await;

    let _ = sqlx::query(
        r#"
        INSERT INTO chat_messages (id, user_id, chat_session_id, session_id, role, content, citations)
        VALUES ($1, $2, $3, $4, 'assistant', $5, $6)
        "#,
    )
    .bind(&ast_msg_id)
    .bind(current_user)
    .bind(&chat_session_id)
    .bind(session_uuid)
    .bind(&cleaned_answer)
    .bind(&citations_json)
    .execute(&pool)
    .await;

    // Update session metrics
    if let Some(s_uuid) = session_uuid {
        let _ = sqlx::query(
            r#"
            UPDATE chat_sessions
            SET last_message_at = NOW(),
                message_count = message_count + 2,
                updated_at = NOW()
            WHERE id = $1
            "#,
        )
        .bind(s_uuid)
        .execute(&pool)
        .await;
    }

    // Step 7: Background auto-titling and rolling summary updates
    let bg_pool = pool.clone();
    let bg_sid = chat_session_id.clone();
    let bg_q = q.clone();
    let bg_api_key = api_key.clone();
    let bg_model = target_model.to_string();
    let prior_count = memory.total_prior_messages;

    tokio::spawn(async move {
        if let Ok(s_uuid) = Uuid::parse_str(&bg_sid) {
            // 1. Auto-title if this is the first turn
            if prior_count <= 1 {
                let should_title = sqlx::query_scalar::<_, bool>(
                    "SELECT title_source = 'auto' AND (title = 'New Conversation' OR title IS NULL) FROM chat_sessions WHERE id = $1"
                )
                .bind(s_uuid)
                .fetch_optional(&bg_pool)
                .await
                .unwrap_or_default()
                .unwrap_or(false);

                if should_title {
                    let prompt = format!(
                        "Generate a concise, descriptive title (3-5 words maximum) for a chat conversation that begins with this user question: \"{}\". Return ONLY the title text with no quotation marks, labels, or formatting.",
                        bg_q
                    );
                    if let Ok(title_res) = call_groq_synthesize(
                        &bg_api_key,
                        &bg_model,
                        "You generate ultra-concise conversation titles.",
                        &prompt,
                    ).await {
                        let clean_title = title_res.trim().trim_matches('"').trim();
                        if !clean_title.is_empty() && clean_title.len() < 60 {
                            let _ = sqlx::query(
                                "UPDATE chat_sessions SET title = $1, title_source = 'auto', updated_at = NOW() WHERE id = $2"
                            )
                            .bind(clean_title)
                            .bind(s_uuid)
                            .execute(&bg_pool)
                            .await;
                        }
                    }
                }
            }

            // 2. Rolling summary update if conversation exceeds 6 messages
            if prior_count >= 6 {
                if let Ok(all_msgs) = sqlx::query_as::<_, (String, String)>(
                    "SELECT role, content FROM chat_messages WHERE chat_session_id = $1 OR session_id = $2 ORDER BY created_at ASC"
                )
                .bind(&bg_sid)
                .bind(s_uuid)
                .fetch_all(&bg_pool)
                .await {
                    if all_msgs.len() > 6 {
                        let mut transcript = String::new();
                        for (role, content) in &all_msgs {
                            let excerpt: String = content.chars().take(250).collect();
                            transcript.push_str(&format!("{}: {}\n", role, excerpt));
                        }
                        let prompt = format!(
                            "Summarize the ongoing conversation below in 2 concise paragraphs, capturing key user intents, decisions, action items, and referenced meetings:\n\n{}",
                            transcript
                        );
                        if let Ok(sum_res) = call_groq_synthesize(
                            &bg_api_key,
                            &bg_model,
                            "You are a conversation summarizer. Provide concise, high-density factual summaries.",
                            &prompt,
                        ).await {
                            let clean_sum = sum_res.trim();
                            if !clean_sum.is_empty() {
                                let _ = sqlx::query(
                                    "UPDATE chat_sessions SET summary = $1, updated_at = NOW() WHERE id = $2"
                                )
                                .bind(clean_sum)
                                .bind(s_uuid)
                                .execute(&bg_pool)
                                .await;
                            }
                        }
                    }
                }
            }
        }
    });

    let _ = on_event.send(ChatStreamEvent::Done {
        answer: cleaned_answer,
        citations,
        relevancy_score,
        relevancy_label,
        is_fallback,
    });

    Ok(())
}

/// Send message to the Meeting Chatbot (Standard Non-streaming)
#[tauri::command]
pub async fn api_chat_send_message(
    state: State<'_, AppState>,
    query: String,
    chat_session_id: String,
    project_ids: Option<Vec<String>>,
) -> Result<ChatApiResponse, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Err("Question cannot be empty".to_string());
    }

    let pool = state.db_manager.pool().clone();
    let current_user = *state.current_user_id.read().await;

    // Step 0: Check greetings
    if let Some(greeting_reply) = check_greeting(&q) {
        let user_msg_id = format!("msg-{}", Uuid::new_v4());
        let ast_msg_id = format!("msg-{}", Uuid::new_v4());
        let _ = sqlx::query(
            "INSERT INTO chat_messages (id, user_id, chat_session_id, role, content, citations) VALUES ($1, $2, $3, 'user', $4, NULL), ($5, $2, $3, 'assistant', $6, NULL)"
        )
        .bind(&user_msg_id)
        .bind(current_user)
        .bind(&chat_session_id)
        .bind(&q)
        .bind(&ast_msg_id)
        .bind(greeting_reply)
        .execute(&pool)
        .await;

        return Ok(ChatApiResponse {
            answer: greeting_reply.to_string(),
            citations: Vec::new(),
            relevancy_score: 1.0,
            relevancy_label: "Direct Greeting".to_string(),
            is_fallback: false,
            recent_meetings: None,
        });
    }

    // Step 1: Check Groq API Key
    let model_config = SettingsRepository::get_model_config_for_user(&pool, current_user)
        .await
        .map_err(|e| format!("Failed to read settings: {}", e))?;

    let groq_api_key = model_config
        .as_ref()
        .and_then(|c| c.groq_api_key.clone())
        .or_else(|| std::env::var("GROQ_API_KEY").ok())
        .filter(|k| !k.trim().is_empty());

    let api_key = match groq_api_key {
        Some(k) => k,
        None => {
            return Err("Groq API Key is not configured. Please open Settings -> AI Model and enter your Groq API Key to enable the meeting chatbot.".to_string());
        }
    };

    // Step 2: Extract @project: tags from query & resolve effective project scope
    let (mentioned_project_names, cleaned_user_query) = extract_project_tags_from_query(&q);
    let explicit_uuids = project_ids.map(|ids| {
        ids.into_iter()
            .filter_map(|s| Uuid::parse_str(&s).ok())
            .collect::<Vec<Uuid>>()
    });

    let (project_scope, target_project_names) = resolve_effective_project_scope(
        &pool,
        &chat_session_id,
        current_user,
        explicit_uuids,
        &mentioned_project_names,
    )
    .await;

    // Step 3: Load Multi-Turn Conversation Memory & Target Model
    let target_model = model_config
        .as_ref()
        .map(|c| c.model.trim())
        .filter(|m| !m.is_empty() && !m.contains("whisper") && !m.contains("llama"))
        .unwrap_or("openai/gpt-oss-120b");

    let memory = load_conversation_memory(&pool, &chat_session_id, current_user).await;

    // Step 4: Intelligent Query Analysis & Routing (Intent + Search Query in a single fast call)
    let query_to_analyze = if cleaned_user_query.is_empty() { &q } else { &cleaned_user_query };
    let analysis = analyze_and_rewrite_query(&api_key, target_model, query_to_analyze, &memory).await;

    let (latest_scoped_meetings, search_query, query_vector_str, chunks, insights) = match analysis.intent {
        QueryIntent::GeneralOverview => {
            // =========================================================================
            // PATH A: Purely Generic Overview / Cross-Meeting Status
            // =========================================================================
            let meetings = fetch_latest_meetings_for_scope(&pool, current_user, project_scope.as_deref(), 5).await;
            if meetings.is_empty() {
                return Ok(ChatApiResponse {
                    answer: "You don't have any recorded meetings in your accessible project scope yet. Once you record or import meetings, I can analyze action items, decisions, and summaries for you!".to_string(),
                    citations: Vec::new(),
                    relevancy_score: 0.0,
                    relevancy_label: "No Meetings Found".to_string(),
                    is_fallback: true,
                    recent_meetings: None,
                });
            }

            let m_ids: Vec<String> = meetings.iter().map(|m| m.id.clone()).collect();
            // Fetch 1 summary chunk per meeting (5 chunks max)
            let chs = fetch_representative_chunks_for_meetings(&pool, &m_ids, 1).await;
            // Fetch up to 8 action items / decisions from these meetings
            let ins = fetch_scoped_insights(&pool, project_scope.as_deref(), current_user, Some(&m_ids), 8).await;

            (meetings, analysis.search_query, None, chs, ins)
        }
        QueryIntent::SpecificSearch => {
            // =========================================================================
            // PATH B: Specific Topic / Keyword Search (Hybrid Vector + FTS RRF)
            // =========================================================================
            let rewritten_query = analysis.search_query;
            let keywords = extract_search_keywords(&rewritten_query);
            let q_vec = fetch_query_embedding_local(&rewritten_query).await;

            // Fetch top 6 chunks across the scope via Hybrid RRF search
            let chs = search_knowledge_chunks(
                &pool,
                project_scope.as_deref(),
                &keywords,
                q_vec.as_deref(),
                current_user,
                6,
                None,
            )
            .await;

            // Fetch up to 6 project-scoped insights
            let ins = fetch_scoped_insights(&pool, project_scope.as_deref(), current_user, None, 6).await;

            (Vec::new(), rewritten_query, q_vec, chs, ins)
        }
    };

    // Terminal Logging for visibility
    let mut chunk_project_map: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for c in &chunks {
        *chunk_project_map.entry(c.project_name.clone()).or_insert(0) += 1;
    }

    info!("==================== [Chatbot Query Non-Streaming] ====================");
    info!("[Chatbot] Session ID    : {}", chat_session_id);
    info!("[Chatbot] Raw Question  : \"{}\"", q);
    if !cleaned_user_query.is_empty() && cleaned_user_query != q {
        info!("[Chatbot] Cleaned Query : \"{}\"", cleaned_user_query);
    }
    info!("[Chatbot] Search Query  : \"{}\"", search_query);
    info!(
        "[Chatbot] Target Scope  : {:?} (IDs: {:?})",
        target_project_names,
        project_scope
    );
    info!(
        "[Chatbot] Query Mode    : {:?}",
        analysis.intent
    );
    if !latest_scoped_meetings.is_empty() {
        let meeting_labels: Vec<String> = latest_scoped_meetings
            .iter()
            .map(|m| format!("\"{}\" [{}] ({})", m.title, m.project_name, m.created_at.format("%Y-%m-%d")))
            .collect();
        info!("[Chatbot] Latest 5 Mtgs : {:?}", meeting_labels);
    }
    info!(
        "[Chatbot] Embedding     : {}",
        if query_vector_str.is_some() {
            "FastEmbed 384d Local OK (127.0.0.1:8123)"
        } else {
            "Local FastEmbed OFFLINE -> Falling back to PostgreSQL Keyword FTS"
        }
    );
    info!(
        "[Chatbot] Chunks Found  : {} across projects: {:?}",
        chunks.len(),
        chunk_project_map
    );
    info!("=======================================================================");

    if chunks.is_empty() && insights.is_empty() {
        let recent = fetch_recent_meetings(&pool, current_user, project_scope.as_deref()).await;
        return Ok(ChatApiResponse {
            answer: "I couldn't find any relevant discussions or records for this question in your selected project scope. Feel free to rephrase or mention another project (e.g. `@project:ProjectName`)!".to_string(),
            citations: Vec::new(),
            relevancy_score: 0.0,
            relevancy_label: "No Relevant Records".to_string(),
            is_fallback: true,
            recent_meetings: Some(recent),
        });
    }

    // Step 7: Construct Synthesis Context with Multi-Turn Memory & Chunks
    let mut context_builder = String::new();

    if let Some(intent) = &memory.anchored_intent {
        context_builder.push_str(&format!("=== CONVERSATION TOPIC / ORIGINAL INTENT ===\n{}\n\n", intent));
    }

    if let Some(sum) = &memory.rolling_summary {
        context_builder.push_str(&format!("=== PRIOR CONVERSATION SUMMARY ===\n{}\n\n", sum));
    }

    if !memory.recent_turns.is_empty() {
        context_builder.push_str("=== RECENT CONVERSATION TURNS ===\n");
        for (role, text) in &memory.recent_turns {
            let label = if role == "user" { "User" } else { "Assistant" };
            context_builder.push_str(&format!("{}: {}\n", label, text.trim()));
        }
        context_builder.push_str("\n(Note: Prior assistant responses are for conversation continuity. Ground any factual claims about meetings exclusively in the RELEVANT MEETING KNOWLEDGE chunks below).\n\n");
    }

    if !latest_scoped_meetings.is_empty() {
        context_builder.push_str("=== LATEST RECORDED MEETINGS (CHRONOLOGICAL ORDER, NEWEST FIRST) ===\n");
        for (idx, m) in latest_scoped_meetings.iter().enumerate() {
            context_builder.push_str(&format!(
                "{}. \"{}\" [Project: {}] (Date: {}, ID: {})\n",
                idx + 1,
                m.title,
                m.project_name,
                m.created_at.format("%Y-%m-%d"),
                m.id
            ));
        }
        context_builder.push_str("\n(Note: The user asked a general/overview question. Focus your analysis and synthesis strictly across these latest recorded meetings in chronological order).\n\n");
    }

    if !chunks.is_empty() {
        context_builder.push_str("=== RELEVANT MEETING KNOWLEDGE & TRANSCRIPT CHUNKS ===\n");
        for (idx, c) in chunks.iter().enumerate() {
            let s_id = format!("S{}", idx + 1);
            let time_info = match (c.start_seconds, c.end_seconds) {
                (Some(s), Some(e)) => {
                    let sm = (s / 60.0).floor() as i32;
                    let ss = (s % 60.0).floor() as i32;
                    let em = (e / 60.0).floor() as i32;
                    let es = (e % 60.0).floor() as i32;
                    format!(" [{:02}:{:02}-{:02}:{:02}]", sm, ss, em, es)
                }
                _ => String::new(),
            };
            let speakers_info = if !c.speakers.is_empty() {
                format!(" (Speakers: {})", c.speakers.join(", "))
            } else {
                String::new()
            };
            context_builder.push_str(&format!(
                "[{}] [Project: {}] Meeting: \"{}\" (ID: {}, Date: {}{}{})\n{}\n\n",
                s_id,
                c.project_name,
                c.meeting_title,
                c.meeting_id,
                c.meeting_date.format("%Y-%m-%d"),
                time_info,
                speakers_info,
                c.content.trim()
            ));
        }
    }

    if !insights.is_empty() {
        context_builder.push_str("=== IDENTIFIED ACTION ITEMS & DECISIONS ===\n");
        for ins in &insights {
            let owner = ins
                .owner_name
                .as_deref()
                .map(|o| format!(" (Owner: {})", o))
                .unwrap_or_default();
            context_builder.push_str(&format!(
                "- [{}] from \"{}\" (ID: {}): {}{}\n",
                ins.insight_type.to_uppercase(),
                ins.meeting_title,
                ins.meeting_id,
                ins.content,
                owner
            ));
        }
        context_builder.push('\n');
    }

    let system_prompt = r#"You are CrestMeet's AI Meeting Knowledge Assistant.
Answer the user's question accurately using ONLY the meeting records and excerpts provided in the context.
Rules:
1. When stating facts or conclusions from specific meetings, cite each source inline using [S#] or [[meeting_id: Meeting Title]]. For example: "The deployment was scheduled for Friday [S1] and pricing was capped at 15% [S2]."
2. If citing decisions or action items, state the owner and due date if available.
3. If the provided context does NOT contain enough information to answer the question, state clearly that you could not find this in their recorded meetings.
4. Keep answers clear, professional, concise, and structured with markdown bullet points.
5. If providing markdown tables, avoid raw HTML tags like <br>. Separate distinct items on separate rows or format them cleanly with bullet points.
6. When comparing or discussing multiple projects, clearly separate and identify which facts belong to which project. Use project names when contrasting decisions, architectures, or roadmaps.
7. For general overview, pending action items, recent decisions, or milestone queries, summarize strictly across the latest recorded meetings listed above in chronological order. Group or highlight discussions clearly by meeting and project."#;

    let user_prompt = format!(
        "Context Information:\n{}\n\nUser Question: {}",
        context_builder, q
    );

    let target_model = model_config
        .as_ref()
        .map(|c| c.model.trim())
        .filter(|m| !m.is_empty() && !m.contains("whisper") && !m.contains("llama"))
        .unwrap_or("openai/gpt-oss-120b");

    let raw_answer = call_groq_synthesize(&api_key, target_model, system_prompt, &user_prompt).await?;
    let citations = extract_verified_citations(&raw_answer, &chunks);
    let cleaned_answer = clean_answer_citations(&raw_answer);

    let is_empty_answer = raw_answer.to_lowercase().contains("could not find")
        || raw_answer.to_lowercase().contains("no information");

    let (relevancy_score, relevancy_label, is_fallback, recent_meetings) = if is_empty_answer {
        let recent = fetch_recent_meetings(&pool, current_user, project_scope.as_deref()).await;
        (0.2, "Low Relevancy".to_string(), true, Some(recent))
    } else if citations.len() >= 2 {
        (
            0.95,
            format!("High Relevancy ({} Meetings Cited)", citations.len()),
            false,
            None,
        )
    } else if citations.len() == 1 {
        (
            0.85,
            "High Relevancy (1 Meeting Cited)".to_string(),
            false,
            None,
        )
    } else {
        (0.70, "General Knowledge Match".to_string(), false, None)
    };

    let user_msg_id = format!("msg-{}", Uuid::new_v4());
    let ast_msg_id = format!("msg-{}", Uuid::new_v4());
    let citations_json = serde_json::to_string(&citations).ok();
    let session_uuid = Uuid::parse_str(&chat_session_id).ok();

    let _ = sqlx::query(
        r#"
        INSERT INTO chat_messages (id, user_id, chat_session_id, session_id, role, content, citations)
        VALUES ($1, $2, $3, $4, 'user', $5, NULL)
        "#,
    )
    .bind(&user_msg_id)
    .bind(current_user)
    .bind(&chat_session_id)
    .bind(session_uuid)
    .bind(&q)
    .execute(&pool)
    .await;

    let _ = sqlx::query(
        r#"
        INSERT INTO chat_messages (id, user_id, chat_session_id, session_id, role, content, citations)
        VALUES ($1, $2, $3, $4, 'assistant', $5, $6)
        "#,
    )
    .bind(&ast_msg_id)
    .bind(current_user)
    .bind(&chat_session_id)
    .bind(session_uuid)
    .bind(&cleaned_answer)
    .bind(&citations_json)
    .execute(&pool)
    .await;

    if let Some(s_uuid) = session_uuid {
        let _ = sqlx::query(
            r#"
            UPDATE chat_sessions
            SET last_message_at = NOW(),
                message_count = message_count + 2,
                updated_at = NOW()
            WHERE id = $1
            "#,
        )
        .bind(s_uuid)
        .execute(&pool)
        .await;
    }

    Ok(ChatApiResponse {
        answer: cleaned_answer,
        citations,
        relevancy_score,
        relevancy_label,
        is_fallback,
        recent_meetings,
    })
}

/// Retrieve conversation history for a chat session
#[tauri::command]
pub async fn api_chat_get_history(
    state: State<'_, AppState>,
    chat_session_id: String,
) -> Result<Vec<ChatMessageRecord>, String> {
    let pool = state.db_manager.pool().clone();
    let current_user = *state.current_user_id.read().await;

    let rows = if let Some(uid) = current_user {
        sqlx::query_as::<_, (String, String, String, Option<String>, chrono::DateTime<Utc>)>(
            r#"
            SELECT id, role, content, citations, created_at
            FROM chat_messages
            WHERE user_id = $1 AND (chat_session_id = $2 OR session_id::text = $2)
            ORDER BY created_at ASC
            LIMIT 50
            "#,
        )
        .bind(uid)
        .bind(&chat_session_id)
        .fetch_all(&pool)
        .await
        .unwrap_or_default()
    } else {
        sqlx::query_as::<_, (String, String, String, Option<String>, chrono::DateTime<Utc>)>(
            r#"
            SELECT id, role, content, citations, created_at
            FROM chat_messages
            WHERE chat_session_id = $1 OR session_id::text = $1
            ORDER BY created_at ASC
            LIMIT 50
            "#,
        )
        .bind(&chat_session_id)
        .fetch_all(&pool)
        .await
        .unwrap_or_default()
    };

    let history = rows
        .into_iter()
        .map(|(id, role, content, citations_str, created_at)| {
            let citations: Option<Vec<MeetingCitation>> = citations_str
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok());

            ChatMessageRecord {
                id,
                role,
                content,
                citations,
                relevancy_label: None,
                relevancy_score: None,
                created_at: created_at.to_rfc3339(),
            }
        })
        .collect();

    Ok(history)
}

/// Clear conversation history for a chat session
#[tauri::command]
pub async fn api_chat_clear_history(
    state: State<'_, AppState>,
    chat_session_id: String,
) -> Result<bool, String> {
    let pool = state.db_manager.pool().clone();
    let current_user = *state.current_user_id.read().await;

    let res = if let Some(uid) = current_user {
        sqlx::query("DELETE FROM chat_messages WHERE user_id = $1 AND (chat_session_id = $2 OR session_id::text = $2)")
            .bind(uid)
            .bind(&chat_session_id)
            .execute(&pool)
            .await
    } else {
        sqlx::query("DELETE FROM chat_messages WHERE chat_session_id = $1 OR session_id::text = $1")
            .bind(&chat_session_id)
            .execute(&pool)
            .await
    };

    match res {
        Ok(_) => Ok(true),
        Err(e) => Err(format!("Failed to clear chat history: {}", e)),
    }
}

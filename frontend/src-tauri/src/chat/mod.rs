// src/chat/mod.rs

use chrono::Utc;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::HashSet;
use std::time::Duration;
use tauri::State;
use tracing::info;
use uuid::Uuid;

use crate::database::repositories::setting::SettingsRepository;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCitation {
    pub meeting_id: String,
    pub meeting_title: String,
    pub date: String,
    pub snippet: Option<String>,
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

/// Meeting summary record pulled from DB
#[derive(Debug, Clone)]
struct MeetingSummaryItem {
    id: String,
    title: String,
    created_at: String,
    summary_text: String,
    decisions: Vec<String>,
    action_items: Vec<String>,
}

/// Verbatim transcript row pulled from DB
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct TranscriptDialogueItem {
    meeting_id: String,
    meeting_title: String,
    created_at: String,
    transcript: String,
    timestamp: String,
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
/// Preserves business verbs, participant words, and technical terms
fn extract_search_keywords(query: &str) -> Vec<String> {
    let stop_words: HashSet<&'static str> = [
        "the", "a", "an", "in", "on", "at", "to", "for", "of", "with",
        "is", "was", "are", "were", "be", "been", "being",
        "it", "this", "that", "these", "those",
        "can", "could", "would", "will", "should",
        "please", "just", "also", "very", "really",
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

/// Classify intent: Action Items vs Decisions vs General Topic
#[derive(Debug, PartialEq, Eq)]
enum QueryIntent {
    ActionItems,
    Decisions,
    SummaryOverview,
    GeneralSearch,
}

fn classify_intent(query: &str) -> QueryIntent {
    let q = query.to_lowercase();
    if q.contains("action item") || q.contains("action items") || q.contains("todo") || q.contains("pending task") || q.contains("tasks assigned") {
        QueryIntent::ActionItems
    } else if q.contains("decision") || q.contains("decisions") || q.contains("what did we decide") || q.contains("agreed on") {
        QueryIntent::Decisions
    } else if q.contains("summarize all") || q.contains("summary of all") || q.contains("meetings this week") || q.contains("recap") {
        QueryIntent::SummaryOverview
    } else {
        QueryIntent::GeneralSearch
    }
}

/// Fetch all meeting summaries for the user
async fn fetch_user_meeting_catalog(pool: &PgPool, user_id: Option<Uuid>) -> Vec<MeetingSummaryItem> {
    let rows = if let Some(uid) = user_id {
        sqlx::query_as::<_, (String, String, chrono::DateTime<Utc>, Option<String>)>(
            r#"
            SELECT m.id, m.title, m.created_at, s.result
            FROM meetings m
            LEFT JOIN summary_processes s ON m.id = s.meeting_id
            WHERE m.user_id = $1
            ORDER BY m.created_at DESC
            LIMIT 40
            "#,
        )
        .bind(uid)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
    } else {
        sqlx::query_as::<_, (String, String, chrono::DateTime<Utc>, Option<String>)>(
            r#"
            SELECT m.id, m.title, m.created_at, s.result
            FROM meetings m
            LEFT JOIN summary_processes s ON m.id = s.meeting_id
            ORDER BY m.created_at DESC
            LIMIT 40
            "#,
        )
        .fetch_all(pool)
        .await
        .unwrap_or_default()
    };

    rows.into_iter()
        .map(|(id, title, created_at, result_json)| {
            let mut summary_text = String::new();
            let mut decisions = Vec::new();
            let mut action_items = Vec::new();

            if let Some(raw_json) = result_json {
                if let Ok(val) = serde_json::from_str::<Value>(&raw_json) {
                    // Extract summary overview
                    if let Some(overview) = val.get("overview").and_then(|v| v.as_str()) {
                        summary_text = overview.to_string();
                    } else if let Some(sum) = val.get("summary").and_then(|v| v.as_str()) {
                        summary_text = sum.to_string();
                    }

                    // Extract decisions
                    if let Some(arr) = val.get("decisions").and_then(|v| v.as_array()) {
                        for item in arr {
                            if let Some(s) = item.as_str() {
                                decisions.push(s.to_string());
                            } else if let Some(desc) = item.get("description").and_then(|v| v.as_str()) {
                                decisions.push(desc.to_string());
                            }
                        }
                    }

                    // Extract action items
                    if let Some(arr) = val.get("action_items").and_then(|v| v.as_array()) {
                        for item in arr {
                            if let Some(s) = item.as_str() {
                                action_items.push(s.to_string());
                            } else if let Some(desc) = item.get("description").and_then(|v| v.as_str()) {
                                let assignee = item.get("assignee").and_then(|v| v.as_str()).unwrap_or("");
                                if !assignee.is_empty() {
                                    action_items.push(format!("{} (Assignee: {})", desc, assignee));
                                } else {
                                    action_items.push(desc.to_string());
                                }
                            }
                        }
                    }
                }
            }

            MeetingSummaryItem {
                id,
                title,
                created_at: created_at.format("%Y-%m-%d").to_string(),
                summary_text,
                decisions,
                action_items,
            }
        })
        .collect()
}

/// Search verbatim transcript dialogue using meeting keywords
async fn search_transcript_dialogue(
    pool: &PgPool,
    user_id: Option<Uuid>,
    keywords: &[String],
) -> Vec<TranscriptDialogueItem> {
    if keywords.is_empty() {
        return Vec::new();
    }

    // Build ILIKE wildcards
    let patterns: Vec<String> = keywords.iter().map(|k| format!("%{}%", k)).collect();

    let query_str = if user_id.is_some() {
        r#"
        SELECT m.id, m.title, m.created_at, t.transcript, t.timestamp
        FROM meetings m
        JOIN transcripts t ON m.id = t.meeting_id
        WHERE m.user_id = $1 AND LOWER(t.transcript) LIKE ANY($2)
        ORDER BY m.created_at DESC
        LIMIT 15
        "#
    } else {
        r#"
        SELECT m.id, m.title, m.created_at, t.transcript, t.timestamp
        FROM meetings m
        JOIN transcripts t ON m.id = t.meeting_id
        WHERE LOWER(t.transcript) LIKE ANY($1)
        ORDER BY m.created_at DESC
        LIMIT 15
        "#
    };

    let rows = if let Some(uid) = user_id {
        sqlx::query_as::<_, (String, String, chrono::DateTime<Utc>, String, String)>(query_str)
            .bind(uid)
            .bind(&patterns)
            .fetch_all(pool)
            .await
            .unwrap_or_default()
    } else {
        sqlx::query_as::<_, (String, String, chrono::DateTime<Utc>, String, String)>(query_str)
            .bind(&patterns)
            .fetch_all(pool)
            .await
            .unwrap_or_default()
    };

    rows.into_iter()
        .map(|(meeting_id, meeting_title, created_at, transcript, timestamp)| {
            TranscriptDialogueItem {
                meeting_id,
                meeting_title,
                created_at: created_at.format("%Y-%m-%d").to_string(),
                transcript,
                timestamp,
            }
        })
        .collect()
}

/// Fetch recent meetings for fallback listing
async fn fetch_recent_meetings(pool: &PgPool, user_id: Option<Uuid>) -> Vec<RecentMeetingInfo> {
    let rows = if let Some(uid) = user_id {
        sqlx::query_as::<_, (String, String, chrono::DateTime<Utc>)>(
            "SELECT id, title, created_at FROM meetings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5",
        )
        .bind(uid)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
    } else {
        sqlx::query_as::<_, (String, String, chrono::DateTime<Utc>)>(
            "SELECT id, title, created_at FROM meetings ORDER BY created_at DESC LIMIT 5",
        )
        .fetch_all(pool)
        .await
        .unwrap_or_default()
    };

    rows.into_iter()
        .map(|(id, title, dt)| RecentMeetingInfo {
            id,
            title,
            date: dt.format("%Y-%m-%d").to_string(),
        })
        .collect()
}

/// Extract citations of form [[meeting_id: Meeting Title]] from Groq's answer
fn extract_citations(answer: &str, catalog: &[MeetingSummaryItem]) -> Vec<MeetingCitation> {
    let mut citations = Vec::new();
    let mut seen_ids = HashSet::new();

    let mut cursor = answer;
    while let Some(start) = cursor.find("[[") {
        if let Some(end) = cursor[start..].find("]]") {
            let inside = &cursor[start + 2..start + end];
            let parts: Vec<&str> = inside.splitn(2, ':').collect();
            if parts.len() == 2 {
                let id = parts[0].trim().to_string();
                let title = parts[1].trim().to_string();

                if !seen_ids.contains(&id) {
                    seen_ids.insert(id.clone());
                    // Lookup date from catalog
                    let date = catalog
                        .iter()
                        .find(|m| m.id == id)
                        .map(|m| m.created_at.clone())
                        .unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string());

                    citations.push(MeetingCitation {
                        meeting_id: id,
                        meeting_title: title,
                        date,
                        snippet: None,
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

/// Clean citation brackets from answer for smooth reading, or format as standard markdown
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
                // Replace with bold meeting title
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

/// Synthesize answer using Groq API
async fn call_groq_synthesize(
    api_key: &str,
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, String> {
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
        "max_tokens": 1500
    });

    let res = client
        .post("https://api.groq.com/openai/v1/chat/completions")
        .headers(headers)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Network request to Groq failed: {}", e))?;

    if !res.status().is_success() {
        let err_text = res.text().await.unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("Groq API error: {}", err_text));
    }

    let body: Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse Groq response JSON: {}", e))?;

    let answer = body["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| "Groq returned empty response content".to_string())?;

    Ok(answer.to_string())
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Send message to the Meeting Chatbot
#[tauri::command]
pub async fn api_chat_send_message(
    state: State<'_, AppState>,
    query: String,
    chat_session_id: String,
) -> Result<ChatApiResponse, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Err("Question cannot be empty".to_string());
    }

    let pool = state.db_manager.pool().clone();
    let current_user = *state.current_user_id.read().await;

    // Step 0: Check greetings for instant response
    if let Some(greeting_reply) = check_greeting(&q) {
        // Save user message and assistant reply to DB
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

    // Step 2: Fetch Meeting Catalog & Transcripts
    let catalog = fetch_user_meeting_catalog(&pool, current_user).await;

    if catalog.is_empty() {
        return Ok(ChatApiResponse {
            answer: "You haven't conducted or imported any meetings yet! Once you record or transcribe a meeting, I will be able to answer any questions about it.".to_string(),
            citations: Vec::new(),
            relevancy_score: 0.0,
            relevancy_label: "No Meetings Found".to_string(),
            is_fallback: true,
            recent_meetings: None,
        });
    }

    let intent = classify_intent(&q);
    let keywords = extract_search_keywords(&q);
    let transcript_snippets = search_transcript_dialogue(&pool, current_user, &keywords).await;

    // Step 3: Construct Synthesis Context
    let mut context_builder = String::new();
    context_builder.push_str("=== CONDUCTED MEETINGS SUMMARY CATALOG ===\n");
    for m in &catalog {
        context_builder.push_str(&format!(
            "- Meeting ID: {}\n  Title: {}\n  Date: {}\n",
            m.id, m.title, m.created_at
        ));
        if !m.summary_text.is_empty() {
            context_builder.push_str(&format!("  Summary: {}\n", m.summary_text));
        }
        if !m.decisions.is_empty() && (intent == QueryIntent::Decisions || intent == QueryIntent::GeneralSearch) {
            context_builder.push_str(&format!("  Decisions: {}\n", m.decisions.join("; ")));
        }
        if !m.action_items.is_empty() && (intent == QueryIntent::ActionItems || intent == QueryIntent::GeneralSearch) {
            context_builder.push_str(&format!("  Action Items: {}\n", m.action_items.join("; ")));
        }
        context_builder.push('\n');
    }

    if !transcript_snippets.is_empty() {
        context_builder.push_str("=== RELEVANT VERBATIM TRANSCRIPT SNIPPETS ===\n");
        for t in &transcript_snippets {
            context_builder.push_str(&format!(
                "[{}] (ID: {}) at {}: \"{}\"\n",
                t.meeting_title, t.meeting_id, t.timestamp, t.transcript
            ));
        }
        context_builder.push('\n');
    }

    // Step 4: System Instructions for Groq
    let system_prompt = r#"You are CrestMeet's AI Meeting Knowledge Assistant.
Answer the user's question accurately using ONLY the meeting records and transcript excerpts provided in the context.
Rules:
1. When citing or referencing information from a specific meeting, cite the meeting using this exact syntax: [[meeting_id: Meeting Title]]. Example: According to [[meeting-123: Sprint Planning]], the deadline is next Friday.
2. If you are grouping action items or decisions, mention which meeting each item came from using [[meeting_id: Meeting Title]].
3. If the provided context does NOT contain enough information to answer the question, state clearly that you could not find this information in their past meeting records.
4. Keep answers structured, professional, and well-formatted with markdown bullet points."#;

    let user_prompt = format!(
        "Context Information:\n{}\n\nUser Question: {}",
        context_builder, q
    );

    let target_model = model_config
        .as_ref()
        .map(|c| c.model.trim())
        .filter(|m| !m.is_empty() && !m.contains("whisper") && !m.contains("llama"))
        .unwrap_or("openai/gpt-oss-120b");

    info!("Calling Groq synthesis with model '{}' for chat query: '{}' with {} meetings", target_model, &q, catalog.len());

    let raw_answer = call_groq_synthesize(&api_key, target_model, system_prompt, &user_prompt).await?;
    let citations = extract_citations(&raw_answer, &catalog);
    let cleaned_answer = clean_answer_citations(&raw_answer);

    // Check if Groq could not find anything
    let is_empty_answer = raw_answer.to_lowercase().contains("could not find")
        || raw_answer.to_lowercase().contains("no information")
        || (citations.is_empty() && transcript_snippets.is_empty() && intent == QueryIntent::GeneralSearch);

    let (relevancy_score, relevancy_label, is_fallback, recent_meetings) = if is_empty_answer {
        let recent = fetch_recent_meetings(&pool, current_user).await;
        (0.2, "Low Relevancy".to_string(), true, Some(recent))
    } else if citations.len() >= 2 {
        (0.95, format!("High Relevancy ({} Meetings Cited)", citations.len()), false, None)
    } else if citations.len() == 1 {
        (0.85, "High Relevancy (1 Meeting Cited)".to_string(), false, None)
    } else {
        (0.65, "General Knowledge Match".to_string(), false, None)
    };

    // Step 5: Save messages to chat_messages table
    let user_msg_id = format!("msg-{}", Uuid::new_v4());
    let ast_msg_id = format!("msg-{}", Uuid::new_v4());
    let citations_json = serde_json::to_string(&citations).ok();

    let _ = sqlx::query(
        r#"
        INSERT INTO chat_messages (id, user_id, chat_session_id, role, content, citations)
        VALUES ($1, $2, $3, 'user', $4, NULL)
        "#,
    )
    .bind(&user_msg_id)
    .bind(current_user)
    .bind(&chat_session_id)
    .bind(&q)
    .execute(&pool)
    .await;

    let _ = sqlx::query(
        r#"
        INSERT INTO chat_messages (id, user_id, chat_session_id, role, content, citations)
        VALUES ($1, $2, $3, 'assistant', $4, $5)
        "#,
    )
    .bind(&ast_msg_id)
    .bind(current_user)
    .bind(&chat_session_id)
    .bind(&cleaned_answer)
    .bind(&citations_json)
    .execute(&pool)
    .await;

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
            WHERE user_id = $1 AND chat_session_id = $2
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
            WHERE chat_session_id = $1
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
        sqlx::query("DELETE FROM chat_messages WHERE user_id = $1 AND chat_session_id = $2")
            .bind(uid)
            .bind(&chat_session_id)
            .execute(&pool)
            .await
    } else {
        sqlx::query("DELETE FROM chat_messages WHERE chat_session_id = $1")
            .bind(&chat_session_id)
            .execute(&pool)
            .await
    };

    match res {
        Ok(_) => Ok(true),
        Err(e) => Err(format!("Failed to clear chat history: {}", e)),
    }
}

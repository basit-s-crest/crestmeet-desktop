// src/chat/mod.rs

pub mod sessions;
pub use sessions::*;

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

/// Execute pgvector + FTS hybrid search using PostgreSQL RPC `search_knowledge`
async fn search_knowledge_chunks(
    pool: &PgPool,
    project_ids: Option<&[Uuid]>,
    keywords: &[String],
    query_vector_str: Option<&str>,
    user_id: Option<Uuid>,
    match_count: i32,
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
        FROM search_knowledge($1, $2, CAST($3 AS vector), $4, $5)
        "#,
    )
    .bind(project_ids)
    .bind(keywords)
    .bind(query_vector_str)
    .bind(user_id)
    .bind(match_count)
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
) -> Vec<RetrievedInsight> {
    let rows = sqlx::query_as::<_, (String, String, String, String, Option<String>)>(
        r#"
        SELECT mi.meeting_id, m.title, mi.type, mi.content, mi.owner_name
        FROM meeting_insights mi
        JOIN meetings m ON m.id = mi.meeting_id
        WHERE ($1::uuid[] IS NULL OR mi.project_id = ANY($1))
          AND ($2::uuid IS NULL OR m.user_id = $2)
        ORDER BY mi.created_at DESC
        LIMIT 20
        "#,
    )
    .bind(project_ids)
    .bind(user_id)
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

/// Extract verified citations from answer referencing either [S#] or [[meeting_id: Title]]
fn extract_verified_citations(
    answer: &str,
    chunks: &[RetrievedKnowledgeChunk],
) -> Vec<MeetingCitation> {
    let mut citations = Vec::new();
    let mut seen_ids = HashSet::new();

    // 1. Check numeric source markers [S1], [S2]...
    for (idx, c) in chunks.iter().enumerate() {
        let tag = format!("[S{}]", idx + 1);
        if answer.contains(&tag) && !seen_ids.contains(&c.meeting_id) {
            seen_ids.insert(c.meeting_id.clone());
            citations.push(MeetingCitation {
                meeting_id: c.meeting_id.clone(),
                meeting_title: c.meeting_title.clone(),
                date: c.meeting_date.format("%Y-%m-%d").to_string(),
                snippet: Some(c.content.chars().take(140).collect()),
            });
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

                if !seen_ids.contains(&id) {
                    seen_ids.insert(id.clone());
                    let date = chunks
                        .iter()
                        .find(|c| c.meeting_id == id)
                        .map(|c| c.meeting_date.format("%Y-%m-%d").to_string())
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

/// Resolve project scope for a chat session
async fn resolve_session_project_scope(
    pool: &PgPool,
    chat_session_id: &str,
    active_project_id: Option<Uuid>,
) -> Option<Vec<Uuid>> {
    let session_scope = sqlx::query_scalar::<_, Option<Vec<Uuid>>>(
        "SELECT scope_project_ids FROM chat_sessions WHERE id::text = $1 LIMIT 1",
    )
    .bind(chat_session_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .flatten();

    match session_scope {
        Some(scopes) if !scopes.is_empty() => Some(scopes),
        _ => active_project_id.map(|pid| vec![pid]),
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
    let active_pid = *state.active_project_id.read().await;

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

    // Step 2: Resolve Project Scope & Retrieve Chunks
    let project_scope = resolve_session_project_scope(&pool, &chat_session_id, active_pid).await;
    let keywords = extract_search_keywords(&q);
    let query_vector_str = fetch_query_embedding_local(&q).await;

    let chunks = search_knowledge_chunks(
        &pool,
        project_scope.as_deref(),
        &keywords,
        query_vector_str.as_deref(),
        current_user,
        15,
    )
    .await;

    let insights = fetch_scoped_insights(&pool, project_scope.as_deref(), current_user).await;

    // Send preliminary sources
    let preliminary_sources: Vec<MeetingCitation> = chunks
        .iter()
        .map(|c| MeetingCitation {
            meeting_id: c.meeting_id.clone(),
            meeting_title: c.meeting_title.clone(),
            date: c.meeting_date.format("%Y-%m-%d").to_string(),
            snippet: Some(c.content.chars().take(120).collect()),
        })
        .collect();

    let _ = on_event.send(ChatStreamEvent::Sources {
        citations: preliminary_sources,
    });

    if chunks.is_empty() && insights.is_empty() {
        let no_data_reply = "I couldn't find any relevant discussions or records for this question in your current project scope. Feel free to rephrase or switch project scopes!".to_string();
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

    // Step 3: Construct Synthesis Context
    let mut context_builder = String::new();

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
                "[{}] Meeting: \"{}\" (ID: {}, Date: {}{}{})\n{}\n\n",
                s_id,
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

    // Step 4: System Instructions for Groq
    let system_prompt = r#"You are CrestMeet's AI Meeting Knowledge Assistant.
Answer the user's question accurately using ONLY the meeting records and excerpts provided in the context.
Rules:
1. When stating facts or conclusions from specific meetings, cite each source inline using [S#] or [[meeting_id: Meeting Title]]. For example: "The deployment was scheduled for Friday [S1] and pricing was capped at 15% [S2]."
2. If citing decisions or action items, state the owner and due date if available.
3. If the provided context does NOT contain enough information to answer the question, state clearly that you could not find this in their recorded meetings.
4. Keep answers clear, professional, concise, and structured with markdown bullet points."#;

    let user_prompt = format!(
        "Context Information:\n{}\n\nUser Question: {}",
        context_builder, q
    );

    let target_model = model_config
        .as_ref()
        .map(|c| c.model.trim())
        .filter(|m| !m.is_empty() && !m.contains("whisper") && !m.contains("llama"))
        .unwrap_or("openai/gpt-oss-120b");

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
) -> Result<ChatApiResponse, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Err("Question cannot be empty".to_string());
    }

    let pool = state.db_manager.pool().clone();
    let current_user = *state.current_user_id.read().await;
    let active_pid = *state.active_project_id.read().await;

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

    // Step 2: Retrieve Chunks & Insights
    let project_scope = resolve_session_project_scope(&pool, &chat_session_id, active_pid).await;
    let keywords = extract_search_keywords(&q);
    let query_vector_str = fetch_query_embedding_local(&q).await;

    let chunks = search_knowledge_chunks(
        &pool,
        project_scope.as_deref(),
        &keywords,
        query_vector_str.as_deref(),
        current_user,
        15,
    )
    .await;

    let insights = fetch_scoped_insights(&pool, project_scope.as_deref(), current_user).await;

    if chunks.is_empty() && insights.is_empty() {
        let recent = fetch_recent_meetings(&pool, current_user, project_scope.as_deref()).await;
        return Ok(ChatApiResponse {
            answer: "I couldn't find any relevant discussions or records for this question in your current project scope. Feel free to rephrase or switch project scopes!".to_string(),
            citations: Vec::new(),
            relevancy_score: 0.0,
            relevancy_label: "No Relevant Records".to_string(),
            is_fallback: true,
            recent_meetings: Some(recent),
        });
    }

    // Step 3: Construct Synthesis Context
    let mut context_builder = String::new();
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
                "[{}] Meeting: \"{}\" (ID: {}, Date: {}{}{})\n{}\n\n",
                s_id,
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
4. Keep answers clear, professional, concise, and structured with markdown bullet points."#;

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

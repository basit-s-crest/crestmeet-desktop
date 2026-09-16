use crate::database::repositories::{meeting::MeetingsRepository, setting::SettingsRepository};
use crate::state::AppState;
use crate::summary::llm_client::{generate_summary, LLMProvider};
use chrono::Local;
use log::{info, warn};
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RescheduleEventItem {
    pub id: String,
    pub title: String,
    pub date: String,
    pub start_time: String,
    pub end_time: String,
    pub description: String,
    pub attendees: Vec<String>,
    pub transcript_quote: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct RescheduleExtractionResult {
    pub has_reschedule: bool,
    pub events: Vec<RescheduleEventItem>,
}

// Fallback struct in case an LLM returns a single object instead of an array
#[derive(Debug, Deserialize)]
struct SingleEventFallback {
    has_reschedule: Option<bool>,
    title: Option<String>,
    date: Option<String>,
    start_time: Option<String>,
    end_time: Option<String>,
    description: Option<String>,
    attendees: Option<Vec<String>>,
    transcript_quote: Option<String>,
}

fn clean_json_response(raw: &str) -> String {
    let thinking_re = Regex::new(r"(?s)<think(?:ing)?>.*?</think(?:ing)?>").unwrap();
    let without_thinking = thinking_re.replace_all(raw, "");

    let trimmed = without_thinking.trim();
    if let Some(start) = trimmed.find('{') {
        if let Some(end) = trimmed.rfind('}') {
            return trimmed[start..=end].to_string();
        }
    }
    trimmed.to_string()
}

#[tauri::command]
pub async fn api_extract_reschedule_info<R: Runtime>(
    _app: AppHandle<R>,
    meeting_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<RescheduleExtractionResult, String> {
    info!("Extracting rescheduling / follow-up information for meeting {}", meeting_id);

    let pool = state.db_manager.pool();

    // 1. Fetch meeting transcripts
    let (transcripts, _) = MeetingsRepository::get_meeting_transcripts_paginated(pool, &meeting_id, 1000, 0)
        .await
        .map_err(|e| format!("Failed to load transcripts: {}", e))?;

    if transcripts.is_empty() {
        return Ok(RescheduleExtractionResult::default());
    }

    let transcript_text = transcripts
        .iter()
        .map(|t| t.transcript.as_str())
        .collect::<Vec<_>>()
        .join(" ");

    // 2. Fetch meeting metadata to anchor relative dates like "tomorrow", "next Monday"
    let meeting_info = MeetingsRepository::get_meeting(pool, &meeting_id).await.ok().flatten();
    let meeting_date_str = meeting_info
        .map(|m| m.created_at.chars().take(10).collect::<String>())
        .unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());

    // 3. Fetch model config
    let config = SettingsRepository::get_model_config(pool)
        .await
        .map_err(|e| format!("Database error fetching model config: {}", e))?
        .ok_or_else(|| "No AI model configured. Please configure a model in Settings -> Summary.".to_string())?;

    let provider = LLMProvider::from_str(&config.provider)?;
    let api_key = if provider != LLMProvider::Ollama && provider != LLMProvider::BuiltInAI {
        SettingsRepository::get_api_key(pool, &config.provider)
            .await
            .map_err(|e| format!("Failed to retrieve API key: {}", e))?
            .unwrap_or_default()
    } else {
        String::new()
    };

    let system_prompt = format!(
        r#"You are an AI assistant analyzing meeting transcripts to extract all scheduling, follow-up, or rescheduling agreements.
The current meeting occurred on: {meeting_date}.

Analyze the provided transcript carefully. Check if the participants explicitly discussed or agreed on one or more follow-up calls, next meetings, or rescheduling future sessions (e.g. "Let's connect next Tuesday at 3 PM", "Let's follow up tomorrow at 10 AM", "Let's push our weekly sync to Friday", "Also let's meet with the client next Thursday at 2 PM").

CRITICAL INSTRUCTIONS:
1. If NO follow-up or rescheduled meeting was discussed or agreed, return:
   {{
     "has_reschedule": false,
     "events": []
   }}
2. If one or MORE follow-up or rescheduled meetings were discussed, extract EACH meeting as an item in the "events" array:
   - "id": unique string "event-1", "event-2", etc.
   - "title": A clear concise title for that next meeting (e.g. "Follow-up: Project Roadmap Sync")
   - "date": The calculated date in YYYY-MM-DD format (resolve relative dates based on {meeting_date}).
   - "start_time": The start time in 24-hour HH:MM format (e.g. "14:30"). If only hour given without AM/PM, infer from context or default to business hours. Default to "10:00" if no time mentioned.
   - "end_time": The end time in 24-hour HH:MM format (default to 30 minutes after start_time if duration not specified).
   - "description": Context, agenda, and topics discussed in this transcript for this next meeting.
   - "attendees": Any specific names or emails mentioned to attend.
   - "transcript_quote": The exact quotation or sentence from the transcript where this specific meeting was agreed.

YOU MUST RESPOND ONLY WITH A VALID JSON OBJECT matching this schema:
{{
  "has_reschedule": boolean,
  "events": [
    {{
      "id": string,
      "title": string,
      "date": "YYYY-MM-DD",
      "start_time": "HH:MM",
      "end_time": "HH:MM",
      "description": string,
      "attendees": [string],
      "transcript_quote": string
    }}
  ]
}}
Do NOT output markdown backticks or explanations. Output pure JSON only."#,
        meeting_date = meeting_date_str
    );

    let client = Client::new();
    let raw_response = generate_summary(
        &client,
        &provider,
        &config.model,
        &api_key,
        &system_prompt,
        &transcript_text,
        config.ollama_endpoint.as_deref(),
        None,
        Some(1200),
        Some(0.2),
        None,
        None,
        None,
    )
    .await?;

    let cleaned_json = clean_json_response(&raw_response);

    // 1. Try parsing as multi-event schema
    if let Ok(mut result) = serde_json::from_str::<RescheduleExtractionResult>(&cleaned_json) {
        if !result.events.is_empty() {
            result.has_reschedule = true;
        }
        return Ok(result);
    }

    // 2. Fallback: try parsing as single event schema in case LLM returned a single object
    if let Ok(single) = serde_json::from_str::<SingleEventFallback>(&cleaned_json) {
        if single.has_reschedule.unwrap_or(false) && single.title.is_some() {
            let event = RescheduleEventItem {
                id: "event-1".to_string(),
                title: single.title.unwrap_or_default(),
                date: single.date.unwrap_or_default(),
                start_time: single.start_time.unwrap_or_else(|| "10:00".to_string()),
                end_time: single.end_time.unwrap_or_else(|| "10:30".to_string()),
                description: single.description.unwrap_or_default(),
                attendees: single.attendees.unwrap_or_default(),
                transcript_quote: single.transcript_quote.unwrap_or_default(),
            };
            return Ok(RescheduleExtractionResult {
                has_reschedule: true,
                events: vec![event],
            });
        }
    }

    warn!("Failed to parse reschedule extraction JSON: {}", cleaned_json);
    Ok(RescheduleExtractionResult::default())
}

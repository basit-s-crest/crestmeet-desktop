// src/speakers/commands.rs

use crate::database::models::{MeetingSpeaker, Person};
use crate::database::repositories::speakers::SpeakersRepository;
use crate::state::AppState;
use log::{error, info};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use tauri::{AppHandle, Emitter, Runtime, State};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SpeakerEventPayload {
    pub meeting_id: String,
    pub speaker_id: Option<String>,
}

/// Helper: resolve the current authenticated user ID from AppState
async fn get_authenticated_user(state: &AppState) -> Result<Uuid, String> {
    let current = *state.current_user_id.read().await;
    current.ok_or_else(|| "User not authenticated. Please log in first.".to_string())
}

/// List all speaker clusters for a given meeting
#[tauri::command]
pub async fn api_list_meeting_speakers(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<Vec<MeetingSpeaker>, String> {
    let pool = state.db_manager.pool();
    SpeakersRepository::list_speakers_by_meeting(pool, &meeting_id)
        .await
        .map_err(|e| {
            error!("Failed to list meeting speakers: {}", e);
            e.to_string()
        })
}

/// Rename a speaker cluster (locks to 'manual' source and updates display_name)
#[tauri::command]
pub async fn api_rename_speaker<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    speaker_id: String,
    display_name: String,
    person_id: Option<String>,
) -> Result<MeetingSpeaker, String> {
    let pool = state.db_manager.pool();
    let s_uuid = Uuid::from_str(&speaker_id).map_err(|e| format!("Invalid speaker UUID: {}", e))?;
    let p_uuid = match person_id {
        Some(p) if !p.trim().is_empty() => Some(Uuid::from_str(&p).map_err(|e| format!("Invalid person UUID: {}", e))?),
        _ => None,
    };

    let trimmed_name = display_name.trim();
    if trimmed_name.is_empty() {
        return Err("Speaker name cannot be empty".to_string());
    }

    let updated = SpeakersRepository::rename_speaker(pool, s_uuid, trimmed_name, p_uuid)
        .await
        .map_err(|e| {
            error!("Failed to rename speaker: {}", e);
            e.to_string()
        })?;

    // Emit event for real-time frontend refresh
    let _ = app.emit("speakers-updated", SpeakerEventPayload {
        meeting_id: updated.meeting_id.clone(),
        speaker_id: Some(speaker_id.clone()),
    });
    let _ = app.emit("action-items-updated", SpeakerEventPayload {
        meeting_id: updated.meeting_id.clone(),
        speaker_id: Some(speaker_id),
    });

    Ok(updated)
}

/// Merge source speaker cluster into target speaker cluster
#[tauri::command]
pub async fn api_merge_speakers<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
    target_speaker_id: String,
    source_speaker_id: String,
) -> Result<(), String> {
    let pool = state.db_manager.pool();
    let target_uuid = Uuid::from_str(&target_speaker_id).map_err(|e| format!("Invalid target speaker UUID: {}", e))?;
    let source_uuid = Uuid::from_str(&source_speaker_id).map_err(|e| format!("Invalid source speaker UUID: {}", e))?;

    if target_uuid == source_uuid {
        return Err("Cannot merge a speaker into itself".to_string());
    }

    SpeakersRepository::merge_speakers(pool, target_uuid, source_uuid)
        .await
        .map_err(|e| {
            error!("Failed to merge speakers: {}", e);
            e.to_string()
        })?;

    // Emit events for frontend refresh
    let _ = app.emit("speakers-updated", SpeakerEventPayload {
        meeting_id: meeting_id.clone(),
        speaker_id: Some(target_speaker_id.clone()),
    });
    let _ = app.emit("action-items-updated", SpeakerEventPayload {
        meeting_id,
        speaker_id: Some(target_speaker_id),
    });

    Ok(())
}

/// Auto-link the primary microphone cluster ('mic:S0') to the current user's Person record
#[tauri::command]
pub async fn api_auto_link_mic_speaker<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<Option<MeetingSpeaker>, String> {
    let user_id = match get_authenticated_user(&state).await {
        Ok(uid) => uid,
        Err(_) => return Ok(None),
    };

    let pool = state.db_manager.pool();

    // Fetch user email / display name from auth.users if available
    let user_info: Option<(Option<String>, Option<serde_json::Value>)> = sqlx::query_as(
        "SELECT email, raw_user_meta_data FROM auth.users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .unwrap_or(None);

    let (email, meta) = user_info.unwrap_or((None, None));
    let display_name = meta
        .as_ref()
        .and_then(|m| m.get("full_name").or_else(|| m.get("name")))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| email.as_ref().map(|e| e.split('@').next().unwrap_or("Me").to_string()))
        .unwrap_or_else(|| "Me".to_string());

    let result = SpeakersRepository::auto_link_mic_speaker(
        pool,
        &meeting_id,
        user_id,
        &display_name,
        email.as_deref(),
    )
    .await
    .map_err(|e| {
        error!("Failed to auto-link mic speaker: {}", e);
        e.to_string()
    })?;

    if let Some(ref speaker) = result {
        let _ = app.emit("speakers-updated", SpeakerEventPayload {
            meeting_id: meeting_id.clone(),
            speaker_id: Some(speaker.id.to_string()),
        });
        let _ = app.emit("action-items-updated", SpeakerEventPayload {
            meeting_id,
            speaker_id: Some(speaker.id.to_string()),
        });
    }

    Ok(result)
}

/// List all known people for attendee/assignee autocomplete
#[tauri::command]
pub async fn api_list_people(
    state: State<'_, AppState>,
) -> Result<Vec<Person>, String> {
    let pool = state.db_manager.pool();
    let people = sqlx::query_as::<_, Person>(
        "SELECT id, user_id, display_name, email, aliases, created_at, updated_at
         FROM people
         ORDER BY display_name ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| {
        error!("Failed to list people: {}", e);
        e.to_string()
    })?;

    Ok(people)
}

/// Trigger screen OCR name resolution for unresolved speaker clusters in a meeting
#[tauri::command]
pub async fn api_run_screen_ocr_naming<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<usize, String> {
    let pool = state.db_manager.pool();
    let engine = super::ocr::OcrNamingEngine::new();
    engine
        .process_meeting(pool, &meeting_id, Some(&app))
        .await
        .map_err(|e| {
            error!("Screen OCR naming failed: {}", e);
            e.to_string()
        })
}


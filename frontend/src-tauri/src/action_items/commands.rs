// src/action_items/commands.rs

use super::queries::{ActionItemEvidence, ActionItemPatch, ActionItemsQueries, ListActionItemsResponse};
use crate::database::repositories::speakers::SpeakersRepository;
use crate::state::AppState;
use log::{error, info};
use std::str::FromStr;
use tauri::{AppHandle, Emitter, Runtime, State};
use uuid::Uuid;

/// Helper: resolve the current authenticated user ID from AppState
async fn get_authenticated_user(state: &AppState) -> Result<Uuid, String> {
    let current = *state.current_user_id.read().await;
    current.ok_or_else(|| "User not authenticated. Please log in first.".to_string())
}

#[tauri::command]
pub async fn api_list_my_action_items(
    state: State<'_, AppState>,
    tab: Option<String>,
    project_id: Option<String>,
    search: Option<String>,
) -> Result<ListActionItemsResponse, String> {
    let user_id = get_authenticated_user(&state).await?;
    let pool = state.db_manager.pool();
    let p_uuid = project_id.and_then(|p| Uuid::from_str(&p).ok());
    let active_tab = tab.unwrap_or_else(|| "open".to_string());

    ActionItemsQueries::list_action_items(pool, user_id, &active_tab, p_uuid, search.as_deref())
        .await
        .map_err(|e| {
            error!("Failed to list action items: {}", e);
            e.to_string()
        })
}

#[tauri::command]
pub async fn api_update_action_item<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    id: String,
    patch: ActionItemPatch,
) -> Result<bool, String> {
    let item_uuid = Uuid::from_str(&id).map_err(|e| format!("Invalid action item UUID: {}", e))?;
    let pool = state.db_manager.pool();

    let success = ActionItemsQueries::update_action_item(pool, item_uuid, patch)
        .await
        .map_err(|e| {
            error!("Failed to update action item {}: {}", id, e);
            e.to_string()
        })?;

    if success {
        let _ = app.emit("action-items-updated", serde_json::json!({ "id": id }));
    }

    Ok(success)
}

#[tauri::command]
pub async fn api_confirm_action_item<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let item_uuid = Uuid::from_str(&id).map_err(|e| format!("Invalid action item UUID: {}", e))?;
    let pool = state.db_manager.pool();

    let success = ActionItemsQueries::confirm_action_item(pool, item_uuid)
        .await
        .map_err(|e| {
            error!("Failed to confirm action item {}: {}", id, e);
            e.to_string()
        })?;

    if success {
        let _ = app.emit("action-items-updated", serde_json::json!({ "id": id }));
    }

    Ok(success)
}

#[tauri::command]
pub async fn api_reject_action_item<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let item_uuid = Uuid::from_str(&id).map_err(|e| format!("Invalid action item UUID: {}", e))?;
    let pool = state.db_manager.pool();

    let success = ActionItemsQueries::reject_action_item(pool, item_uuid)
        .await
        .map_err(|e| {
            error!("Failed to reject action item {}: {}", id, e);
            e.to_string()
        })?;

    if success {
        let _ = app.emit("action-items-updated", serde_json::json!({ "id": id }));
    }

    Ok(success)
}

#[tauri::command]
pub async fn api_claim_action_item<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let user_id = get_authenticated_user(&state).await?;
    let item_uuid = Uuid::from_str(&id).map_err(|e| format!("Invalid action item UUID: {}", e))?;
    let pool = state.db_manager.pool();

    // Ensure person record exists for user
    let person = SpeakersRepository::get_or_create_person_for_user(pool, user_id, "Me", None)
        .await
        .map_err(|e| format!("Failed to resolve person: {}", e))?;

    let success = ActionItemsQueries::claim_action_item(pool, item_uuid, person.id)
        .await
        .map_err(|e| {
            error!("Failed to claim action item {}: {}", id, e);
            e.to_string()
        })?;

    if success {
        let _ = app.emit("action-items-updated", serde_json::json!({ "id": id }));
    }

    Ok(success)
}

#[tauri::command]
pub async fn api_get_action_item_evidence(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<ActionItemEvidence>, String> {
    let item_uuid = Uuid::from_str(&id).map_err(|e| format!("Invalid action item UUID: {}", e))?;
    let pool = state.db_manager.pool();

    ActionItemsQueries::get_action_item_evidence(pool, item_uuid)
        .await
        .map_err(|e| {
            error!("Failed to get action item evidence {}: {}", id, e);
            e.to_string()
        })
}

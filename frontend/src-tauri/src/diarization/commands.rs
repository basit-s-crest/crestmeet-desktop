// frontend/src-tauri/src/diarization/commands.rs

use tauri::{AppHandle, Runtime, State};
use tracing::{error, info};

use crate::state::AppState;
use super::engine::DiarizationEngine;
use super::models::{DiarizationResult, DiarizationStatus};

/// Trigger offline diarization on a completed meeting
#[tauri::command]
pub async fn api_run_offline_diarization<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<DiarizationResult, String> {
    info!("Triggering api_run_offline_diarization for meeting: {}", meeting_id);
    let pool = state.db_manager.pool();

    let engine = DiarizationEngine::with_default_config();
    engine
        .process_meeting(pool, &meeting_id, Some(&app))
        .await
        .map_err(|e| {
            error!("Offline diarization failed: {}", e);
            e.to_string()
        })
}

/// Query the diarization status of a meeting
#[tauri::command]
pub async fn api_get_meeting_diarization_status(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<DiarizationStatus, String> {
    let pool = state.db_manager.pool();

    let count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM meeting_speakers WHERE meeting_id = $1",
        meeting_id
    )
    .fetch_one(pool)
    .await
    .unwrap_or(Some(0))
    .unwrap_or(0);

    if count > 0 {
        Ok(DiarizationStatus {
            meeting_id,
            status: "completed".to_string(),
            progress: 100,
            error: None,
            speaker_count: count as usize,
        })
    } else {
        Ok(DiarizationStatus {
            meeting_id,
            status: "pending".to_string(),
            progress: 0,
            error: None,
            speaker_count: 0,
        })
    }
}

// src/database/setup.rs

use log::info;
use tauri::{AppHandle, Manager};

use super::manager::DatabaseManager;
use crate::state::AppState;

/// Initialize database on app startup
pub async fn initialize_database_on_startup(app: &AppHandle) -> Result<(), String> {
    info!("Initializing Supabase database connection...");

    let db_url = crate::config::get_database_url();
    let db_manager = DatabaseManager::new_lazy(&db_url)
        .map_err(|e| format!("Failed to create database pool: {}", e))?;

    app.manage(AppState {
        db_manager: db_manager.clone(),
    });

    // Run schema check non-blocking in the background so GUI thread never hangs
    let pool = db_manager.pool().clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = DatabaseManager::init_schema(&pool).await {
            log::warn!("Supabase schema background verification: {}", e);
        }
    });

    info!("Database initialized successfully with Supabase (non-blocking)");
    Ok(())
}

// src/database/setup.rs

use log::info;
use tauri::{AppHandle, Manager};

use super::manager::DatabaseManager;
use crate::state::AppState;

/// Initialize database on app startup
pub async fn initialize_database_on_startup(app: &AppHandle) -> Result<(), String> {
    info!("Initializing Supabase database connection...");

    let db_manager = DatabaseManager::new_from_app_handle(app)
        .await
        .map_err(|e| format!("Failed to connect to Supabase PostgreSQL database: {}", e))?;

    app.manage(AppState { db_manager });
    info!("Database initialized successfully with Supabase");

    Ok(())
}

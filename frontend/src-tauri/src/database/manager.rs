// src/database/manager.rs
//
// Supabase PostgreSQL Database Manager

use crate::config::get_database_url;
use sqlx::{PgPool, Result};
use std::time::Duration;

#[derive(Clone)]
pub struct DatabaseManager {
    pool: PgPool,
}

impl DatabaseManager {
    pub async fn new(database_url: &str) -> Result<Self> {
        log::info!("Connecting to Supabase PostgreSQL database...");

        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(10)
            .acquire_timeout(Duration::from_secs(15))
            .connect(database_url)
            .await?;

        // Initialize schema if not exists
        Self::init_schema(&pool).await?;

        log::info!("✅ Connected to Supabase database successfully");
        Ok(DatabaseManager { pool })
    }

    pub async fn new_from_app_handle(_app_handle: &tauri::AppHandle) -> Result<Self> {
        let db_url = get_database_url();
        Self::new(&db_url).await
    }

    pub async fn is_first_launch(_app_handle: &tauri::AppHandle) -> Result<bool> {
        Ok(false)
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn init_schema(pool: &PgPool) -> Result<()> {
        log::info!("Verifying Supabase database schema...");

        let schema = r#"
            CREATE TABLE IF NOT EXISTS meetings (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                folder_path TEXT
            );

            CREATE TABLE IF NOT EXISTS transcripts (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                transcript TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                summary TEXT,
                action_items TEXT,
                key_points TEXT,
                audio_start_time DOUBLE PRECISION,
                audio_end_time DOUBLE PRECISION,
                duration DOUBLE PRECISION
            );

            CREATE TABLE IF NOT EXISTS summary_processes (
                meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
                status TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                error TEXT,
                result TEXT,
                start_time TIMESTAMPTZ,
                end_time TIMESTAMPTZ,
                chunk_count BIGINT DEFAULT 0,
                processing_time DOUBLE PRECISION DEFAULT 0,
                metadata TEXT,
                result_backup TEXT,
                result_backup_timestamp TIMESTAMPTZ
            );

            CREATE TABLE IF NOT EXISTS transcript_chunks (
                meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
                meeting_name TEXT,
                transcript_text TEXT NOT NULL,
                model TEXT NOT NULL,
                model_name TEXT NOT NULL,
                chunk_size BIGINT,
                overlap BIGINT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS settings (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                "whisperModel" TEXT NOT NULL DEFAULT '',
                "groqApiKey" TEXT,
                "openaiApiKey" TEXT,
                "anthropicApiKey" TEXT,
                "ollamaApiKey" TEXT,
                "openRouterApiKey" TEXT,
                "ollamaEndpoint" TEXT,
                "customOpenAIConfig" TEXT
            );

            CREATE TABLE IF NOT EXISTS transcript_settings (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                "whisperApiKey" TEXT,
                "deepgramApiKey" TEXT,
                "elevenLabsApiKey" TEXT,
                "groqApiKey" TEXT,
                "openaiApiKey" TEXT
            );

            CREATE TABLE IF NOT EXISTS licensing (
                id TEXT PRIMARY KEY,
                key TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS meeting_notes (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                notes_json TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_transcripts_meeting_id ON transcripts(meeting_id);
            CREATE INDEX IF NOT EXISTS idx_meeting_notes_meeting_id ON meeting_notes(meeting_id);
            CREATE INDEX IF NOT EXISTS idx_meetings_created_at ON meetings(created_at DESC);
        "#;

        sqlx::raw_sql(schema).execute(pool).await?;
        log::info!("✅ Supabase schema verified");
        Ok(())
    }
}

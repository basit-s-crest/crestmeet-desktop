// src/database/manager.rs
//
// Supabase PostgreSQL Database Manager

use crate::config::get_database_url;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{PgPool, Result};
use std::str::FromStr;
use std::time::Duration;

#[derive(Clone)]
pub struct DatabaseManager {
    pool: PgPool,
}

impl DatabaseManager {
    pub fn new_lazy(database_url: &str) -> Result<Self> {
        log::info!("Initializing Supabase PostgreSQL database pool (non-blocking)...");

        let connect_options = PgConnectOptions::from_str(database_url)?
            .statement_cache_capacity(0);

        let pool = PgPoolOptions::new()
            .max_connections(10)
            .acquire_timeout(Duration::from_secs(15))
            .connect_lazy_with(connect_options);

        Ok(DatabaseManager { pool })
    }

    pub async fn new(database_url: &str) -> Result<Self> {
        log::info!("Connecting to Supabase PostgreSQL database...");

        let connect_options = PgConnectOptions::from_str(database_url)?
            .statement_cache_capacity(0);

        let pool = PgPoolOptions::new()
            .max_connections(10)
            .acquire_timeout(Duration::from_secs(15))
            .connect_with(connect_options)
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
            CREATE EXTENSION IF NOT EXISTS pgcrypto;

            CREATE TABLE IF NOT EXISTS app_users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

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

            -- Ensure multi-tenant isolation columns exist
            ALTER TABLE meetings ADD COLUMN IF NOT EXISTS user_id UUID;
            ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS user_id UUID;
            ALTER TABLE summary_processes ADD COLUMN IF NOT EXISTS user_id UUID;
            ALTER TABLE transcript_chunks ADD COLUMN IF NOT EXISTS user_id UUID;
            ALTER TABLE settings ADD COLUMN IF NOT EXISTS user_id UUID;
            ALTER TABLE transcript_settings ADD COLUMN IF NOT EXISTS user_id UUID;
            ALTER TABLE licensing ADD COLUMN IF NOT EXISTS user_id UUID;
            ALTER TABLE meeting_notes ADD COLUMN IF NOT EXISTS user_id UUID;

            -- Ensure summary_processes backup and metric columns exist
            ALTER TABLE summary_processes ADD COLUMN IF NOT EXISTS result_backup TEXT;
            ALTER TABLE summary_processes ADD COLUMN IF NOT EXISTS result_backup_timestamp TIMESTAMPTZ;
            ALTER TABLE summary_processes ADD COLUMN IF NOT EXISTS chunk_count BIGINT DEFAULT 0;
            ALTER TABLE summary_processes ADD COLUMN IF NOT EXISTS processing_time DOUBLE PRECISION DEFAULT 0;
            ALTER TABLE summary_processes ADD COLUMN IF NOT EXISTS metadata TEXT;

            -- Ensure additional feature columns exist
            ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS speaker TEXT;
            ALTER TABLE settings ADD COLUMN IF NOT EXISTS "geminiApiKey" TEXT;

            CREATE INDEX IF NOT EXISTS idx_meetings_user_id ON meetings(user_id);
            CREATE INDEX IF NOT EXISTS idx_transcripts_user_id ON transcripts(user_id);
            CREATE INDEX IF NOT EXISTS idx_meeting_notes_user_id ON meeting_notes(user_id);
        "#;

        sqlx::raw_sql(schema).execute(pool).await?;
        log::info!("✅ Supabase schema verified");
        Ok(())
    }

    pub async fn cleanup(&self) -> Result<()> {
        self.pool.close().await;
        Ok(())
    }
}

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

            CREATE TABLE IF NOT EXISTS password_reset_otps (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                email TEXT NOT NULL,
                otp_code TEXT NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                used BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_password_reset_otps_email ON password_reset_otps(email);

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

            CREATE TABLE IF NOT EXISTS chat_messages (
                id TEXT PRIMARY KEY,
                user_id UUID,
                chat_session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                citations TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_meetings_user_id ON meetings(user_id);
            CREATE INDEX IF NOT EXISTS idx_transcripts_user_id ON transcripts(user_id);
            CREATE INDEX IF NOT EXISTS idx_meeting_notes_user_id ON meeting_notes(user_id);
            CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(user_id, chat_session_id, created_at ASC);

            -- =========================================================================
            -- Projects & Membership Schema (Phase 1)
            -- =========================================================================
            CREATE TABLE IF NOT EXISTS projects (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name TEXT NOT NULL,
                description TEXT,
                is_personal BOOLEAN NOT NULL DEFAULT FALSE,
                created_by UUID,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS project_members (
                project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                user_id UUID NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('owner', 'team_leader', 'member')),
                added_by UUID,
                joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (project_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS project_invitations (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                email TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('team_leader', 'member')),
                invited_by UUID,
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                accepted_at TIMESTAMPTZ
            );

            CREATE INDEX IF NOT EXISTS idx_projects_created_by ON projects(created_by);
            CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
            CREATE INDEX IF NOT EXISTS idx_project_invitations_email ON project_invitations(LOWER(email));
            ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;

            -- Denormalized project_id and cloud drive sync on child tables
            ALTER TABLE meetings ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
            ALTER TABLE meetings ADD COLUMN IF NOT EXISTS has_video BOOLEAN NOT NULL DEFAULT FALSE;
            ALTER TABLE meetings ADD COLUMN IF NOT EXISTS video_url TEXT;
            ALTER TABLE meetings ADD COLUMN IF NOT EXISTS drive_file_id TEXT;
            ALTER TABLE meetings ADD COLUMN IF NOT EXISTS upload_status TEXT DEFAULT 'pending';
            ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
            ALTER TABLE summary_processes ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;

            -- Ensure project_invitations supports declined status
            DO $$
            BEGIN
                ALTER TABLE project_invitations DROP CONSTRAINT IF EXISTS project_invitations_status_check;
                ALTER TABLE project_invitations ADD CONSTRAINT project_invitations_status_check CHECK (status IN ('pending', 'accepted', 'declined', 'revoked'));
            EXCEPTION
                WHEN OTHERS THEN NULL;
            END $$;

            -- =========================================================================
            -- Media Requests Schema (P2P On-Demand Media Sharing)
            -- =========================================================================
            CREATE TABLE IF NOT EXISTS media_requests (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
                requested_by UUID NOT NULL,
                recorder_id UUID NOT NULL,
                media_type TEXT NOT NULL DEFAULT 'video',
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'transferring', 'completed', 'declined', 'failed')),
                progress INT NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_media_requests_recorder ON media_requests(recorder_id, status);
            CREATE INDEX IF NOT EXISTS idx_media_requests_meeting ON media_requests(meeting_id);
            CREATE INDEX IF NOT EXISTS idx_media_requests_requested_by ON media_requests(requested_by, status);

            CREATE INDEX IF NOT EXISTS idx_meetings_project_id ON meetings(project_id);
            CREATE INDEX IF NOT EXISTS idx_transcripts_project_id ON transcripts(project_id);
            CREATE INDEX IF NOT EXISTS idx_summary_processes_project_id ON summary_processes(project_id);
            CREATE INDEX IF NOT EXISTS idx_chat_messages_project_id ON chat_messages(project_id);

            -- Auto-denormalize project_id from meetings onto transcripts and summary_processes
            CREATE OR REPLACE FUNCTION set_project_id_from_meeting()
            RETURNS TRIGGER AS $trg$
            BEGIN
                IF NEW.project_id IS NULL AND NEW.meeting_id IS NOT NULL THEN
                    SELECT project_id INTO NEW.project_id FROM meetings WHERE id = NEW.meeting_id;
                END IF;
                RETURN NEW;
            END;
            $trg$ LANGUAGE plpgsql;

            DROP TRIGGER IF EXISTS trg_transcripts_project_id ON transcripts;
            CREATE TRIGGER trg_transcripts_project_id
            BEFORE INSERT ON transcripts
            FOR EACH ROW EXECUTE FUNCTION set_project_id_from_meeting();

            DROP TRIGGER IF EXISTS trg_summary_processes_project_id ON summary_processes;
            CREATE TRIGGER trg_summary_processes_project_id
            BEFORE INSERT ON summary_processes
            FOR EACH ROW EXECUTE FUNCTION set_project_id_from_meeting();

            -- Idempotent backfill migration for existing users & meetings:
            -- Create a default "Personal" project for any user who doesn't have one and link their meetings.
            DO $backfill$
            DECLARE
                r RECORD;
                v_proj_id UUID;
            BEGIN
                FOR r IN (
                    SELECT DISTINCT user_id FROM meetings WHERE user_id IS NOT NULL
                    UNION
                    SELECT id AS user_id FROM app_users
                ) LOOP
                    SELECT id INTO v_proj_id FROM projects WHERE created_by = r.user_id AND is_personal = true LIMIT 1;
                    IF v_proj_id IS NULL THEN
                        INSERT INTO projects (name, is_personal, created_by)
                        VALUES ('Personal', true, r.user_id)
                        RETURNING id INTO v_proj_id;

                        INSERT INTO project_members (project_id, user_id, role)
                        VALUES (v_proj_id, r.user_id, 'owner')
                        ON CONFLICT (project_id, user_id) DO NOTHING;
                    END IF;

                    UPDATE meetings SET project_id = v_proj_id
                    WHERE user_id = r.user_id AND project_id IS NULL;

                    UPDATE transcripts t SET project_id = m.project_id
                    FROM meetings m
                    WHERE t.meeting_id = m.id AND t.project_id IS NULL AND m.project_id IS NOT NULL;

                    UPDATE summary_processes s SET project_id = m.project_id
                    FROM meetings m
                    WHERE s.meeting_id = m.id AND s.project_id IS NULL AND m.project_id IS NOT NULL;
                END LOOP;
            END $backfill$;
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

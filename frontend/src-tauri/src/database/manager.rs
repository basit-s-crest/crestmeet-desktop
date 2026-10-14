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

            -- =========================================================================
            -- Chatbot v2 & RAG Knowledge Base Schema (Phase 2 & 3)
            -- =========================================================================
            DO $$
            BEGIN
                CREATE EXTENSION IF NOT EXISTS vector;
                CREATE EXTENSION IF NOT EXISTS pg_trgm;
            EXCEPTION
                WHEN OTHERS THEN NULL;
            END $$;

            CREATE TABLE IF NOT EXISTS knowledge_chunks (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                source_type TEXT NOT NULL CHECK (source_type IN ('transcript', 'summary')),
                chunk_index INT NOT NULL,
                content TEXT NOT NULL,
                context_header TEXT,
                context_note TEXT,
                speakers TEXT[] NOT NULL DEFAULT '{}',
                start_seconds FLOAT8,
                end_seconds FLOAT8,
                first_transcript_id TEXT,
                last_transcript_id TEXT,
                token_count INT,
                content_hash TEXT NOT NULL,
                embedding VECTOR(384) NOT NULL,
                embedding_model TEXT NOT NULL,
                fts TSVECTOR GENERATED ALWAYS AS (
                    to_tsvector('english', COALESCE(context_header, '') || ' ' || COALESCE(context_note, '') || ' ' || content)
                ) STORED,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (meeting_id, source_type, chunk_index)
            );

            CREATE INDEX IF NOT EXISTS idx_kc_project_meeting ON knowledge_chunks (project_id, meeting_id);
            CREATE INDEX IF NOT EXISTS idx_kc_fts ON knowledge_chunks USING GIN (fts);

            CREATE TABLE IF NOT EXISTS meeting_insights (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                type TEXT NOT NULL CHECK (type IN ('decision', 'action_item', 'risk', 'question', 'deadline', 'key_point')),
                content TEXT NOT NULL,
                owner_name TEXT,
                owner_user_id UUID,
                due_date DATE,
                status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'dropped')),
                significance REAL DEFAULT 1.0,
                source_chunk_id UUID REFERENCES knowledge_chunks(id) ON DELETE SET NULL,
                start_seconds FLOAT8,
                embedding VECTOR(384),
                fts TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_mi_project_type ON meeting_insights (project_id, type, status);
            CREATE INDEX IF NOT EXISTS idx_mi_fts ON meeting_insights USING GIN (fts);

            CREATE TABLE IF NOT EXISTS project_briefs (
                project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                brief TEXT NOT NULL,
                source_meeting_ids TEXT[] NOT NULL DEFAULT '{}',
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS indexing_jobs (
                meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
                project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                stage TEXT NOT NULL DEFAULT 'chunk' CHECK (stage IN ('chunk', 'enrich', 'embed', 'insights', 'summary', 'commit', 'done')),
                status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
                attempts INT NOT NULL DEFAULT 0,
                last_error TEXT,
                embedding_model TEXT,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_indexing_jobs_status ON indexing_jobs (status, stage);

            CREATE TABLE IF NOT EXISTS chat_sessions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL,
                title TEXT,
                title_source TEXT NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto', 'user')),
                scope_project_ids UUID[],
                pinned BOOLEAN NOT NULL DEFAULT FALSE,
                archived_at TIMESTAMPTZ,
                deleted_at TIMESTAMPTZ,
                summary TEXT,
                summary_upto_seq BIGINT,
                message_count INT NOT NULL DEFAULT 0,
                last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_list 
            ON chat_sessions (user_id, last_message_at DESC, id) 
            WHERE deleted_at IS NULL;

            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE;
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS seq BIGINT;
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'message';
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'complete';
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS client_message_id UUID;
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS parent_id TEXT;
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS retrieval_trace JSONB;
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS model TEXT;
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS tokens_in INT;
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS tokens_out INT;
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS latency_ms INT;
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS feedback SMALLINT;

            CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages (session_id, created_at ASC);

            CREATE TABLE IF NOT EXISTS chat_shares (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                created_by UUID NOT NULL,
                visibility TEXT NOT NULL CHECK (visibility IN ('members', 'link')),
                token_hash TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                project_ids UUID[] NOT NULL,
                include_sources BOOLEAN NOT NULL DEFAULT FALSE,
                snapshot_upto_seq BIGINT NOT NULL DEFAULT 0,
                expires_at TIMESTAMPTZ,
                revoked_at TIMESTAMPTZ,
                view_count INT NOT NULL DEFAULT 0,
                last_viewed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS chat_share_messages (
                share_id UUID NOT NULL REFERENCES chat_shares(id) ON DELETE CASCADE,
                position INT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                content TEXT NOT NULL,
                citations JSONB NOT NULL DEFAULT '[]',
                PRIMARY KEY (share_id, position)
            );

            CREATE INDEX IF NOT EXISTS idx_chat_shares_session ON chat_shares (session_id);
            CREATE INDEX IF NOT EXISTS idx_chat_shares_token_hash ON chat_shares (token_hash);

            CREATE OR REPLACE FUNCTION resolve_scope(p_project_ids UUID[], p_user_id UUID DEFAULT NULL)
            RETURNS TABLE (project_id UUID, project_name TEXT)
            LANGUAGE sql STABLE AS $$
                SELECT pm.project_id, p.name
                FROM project_members pm 
                JOIN projects p ON p.id = pm.project_id
                WHERE p_user_id IS NOT NULL
                  AND pm.user_id = p_user_id
                  AND p.is_archived = false
                  AND (p_project_ids IS NULL OR pm.project_id = ANY(p_project_ids));
            $$;

            CREATE OR REPLACE FUNCTION search_knowledge(
                p_project_ids UUID[],
                p_keywords TEXT[],
                p_query_embedding VECTOR(384),
                p_user_id UUID DEFAULT NULL,
                p_match_count INT DEFAULT 30,
                p_meeting_ids TEXT[] DEFAULT NULL,
                p_speakers TEXT[] DEFAULT NULL,
                p_date_from TIMESTAMPTZ DEFAULT NULL,
                p_date_to TIMESTAMPTZ DEFAULT NULL,
                p_rrf_k INT DEFAULT 60
            ) RETURNS TABLE (
                chunk_id UUID,
                project_id UUID,
                project_name TEXT,
                meeting_id TEXT,
                meeting_title TEXT,
                meeting_date TIMESTAMPTZ,
                source_type TEXT,
                content TEXT,
                speakers TEXT[],
                start_seconds FLOAT8,
                end_seconds FLOAT8,
                chunk_index INT,
                cosine_sim FLOAT8,
                vector_rank INT,
                text_rank INT,
                rrf_score FLOAT8
            ) LANGUAGE sql STABLE AS $$
                WITH allowed AS (
                    SELECT project_id, project_name 
                    FROM resolve_scope(p_project_ids, p_user_id)
                ),
                scoped AS (
                    SELECT c.*, a.project_name, m.title AS m_title, COALESCE(m.created_at, NOW()) AS m_date
                    FROM knowledge_chunks c
                    JOIN allowed a ON a.project_id = c.project_id
                    JOIN meetings m ON m.id = c.meeting_id
                    WHERE (p_meeting_ids IS NULL OR c.meeting_id = ANY(p_meeting_ids))
                      AND (p_speakers IS NULL OR c.speakers && p_speakers)
                      AND (p_date_from IS NULL OR m.created_at >= p_date_from)
                      AND (p_date_to IS NULL OR m.created_at <= p_date_to)
                ),
                vec AS (
                    SELECT id, 1 - (embedding <=> p_query_embedding) AS sim,
                           ROW_NUMBER() OVER (ORDER BY embedding <=> p_query_embedding) AS rnk
                    FROM scoped
                    WHERE p_query_embedding IS NOT NULL
                    ORDER BY embedding <=> p_query_embedding
                    LIMIT p_match_count * 2
                ),
                txt AS (
                    SELECT s.id,
                           ROW_NUMBER() OVER (ORDER BY ts_rank_cd(s.fts, q.query) DESC) AS rnk
                    FROM scoped s,
                         websearch_to_tsquery('english', array_to_string(p_keywords, ' or ')) AS q(query)
                    WHERE p_keywords IS NOT NULL AND array_length(p_keywords, 1) > 0 AND s.fts @@ q.query
                    ORDER BY ts_rank_cd(s.fts, q.query) DESC
                    LIMIT p_match_count * 2
                ),
                fused AS (
                    SELECT COALESCE(v.id, t.id) AS id,
                           COALESCE(v.sim, 0.0) AS sim,
                           v.rnk AS vr,
                           t.rnk AS tr,
                           COALESCE(1.0 / (p_rrf_k + v.rnk), 0.0) + COALESCE(1.0 / (p_rrf_k + t.rnk), 0.0) AS score
                    FROM vec v
                    FULL OUTER JOIN txt t ON t.id = v.id
                )
                SELECT s.id, s.project_id, s.project_name, s.meeting_id, s.m_title, s.m_date, s.source_type,
                       s.content, s.speakers, s.start_seconds, s.end_seconds, s.chunk_index,
                       f.sim, COALESCE(f.vr, 0)::INT, COALESCE(f.tr, 0)::INT, f.score
                FROM fused f
                JOIN scoped s ON s.id = f.id
                ORDER BY f.score DESC
                LIMIT p_match_count;
            $$;
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

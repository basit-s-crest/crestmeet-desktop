-- ==============================================================================
-- CrestMeet Chatbot v2 & RAG Knowledge Base Migration
-- ==============================================================================

-- 1. Extensions
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION
    WHEN OTHERS THEN NULL;
END $$;

-- 2. Knowledge Chunks Table (Hybrid Retrieval: Vector + FTS)
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

-- 3. Meeting Insights Table (Decisions, Action Items, Risks, Deadlines)
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

-- 4. Project Briefs Table
CREATE TABLE IF NOT EXISTS project_briefs (
    project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    brief TEXT NOT NULL,
    source_meeting_ids TEXT[] NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Indexing Jobs Table (Resumable Pipeline Tracking)
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

-- 6. Chat Sessions Table (ChatGPT-Style History, Scopes & Rolling Memory)
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

-- 7. Upgrade chat_messages Table to support Monotonic Seq, Citations, Traces
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

-- 8. Chat Shares Tables (Immutable Snapshots)
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

-- 9. RPC Functions: Scope Resolution & Hybrid Search with RRF

CREATE OR REPLACE FUNCTION resolve_scope(p_project_ids UUID[], p_user_id UUID DEFAULT NULL)
RETURNS TABLE (project_id UUID, project_name TEXT)
LANGUAGE sql STABLE AS $$
    SELECT pm.project_id, p.name
    FROM project_members pm 
    JOIN projects p ON p.id = pm.project_id
    WHERE (p_user_id IS NULL OR pm.user_id = p_user_id)
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

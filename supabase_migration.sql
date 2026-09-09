-- ==============================================================================
-- Meetily (CrestMeet) Supabase Multi-Tenant Database Migration
-- Run this script in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query)
-- ==============================================================================

-- 1. Enable pgcrypto for industry-standard bcrypt hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. Create the native app_users table
CREATE TABLE IF NOT EXISTS app_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Clean up existing orphaned/single-user test records if any exist without a user
-- (If you already have records you want to keep, comment out this TRUNCATE line)
TRUNCATE TABLE 
    meetings, 
    transcripts, 
    summary_processes, 
    transcript_chunks, 
    settings, 
    transcript_settings, 
    licensing, 
    meeting_notes 
CASCADE;

-- 4. Modify 'meetings' table to associate with users
ALTER TABLE meetings 
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES app_users(id) ON DELETE CASCADE;

-- 5. Modify 'transcripts' table (denormalized user_id for fast isolation)
ALTER TABLE transcripts 
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES app_users(id) ON DELETE CASCADE;

-- 6. Modify 'meeting_notes' table
ALTER TABLE meeting_notes 
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES app_users(id) ON DELETE CASCADE;

-- 7. Modify 'summary_processes' table
ALTER TABLE summary_processes 
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES app_users(id) ON DELETE CASCADE;

-- 8. Modify 'transcript_chunks' table
ALTER TABLE transcript_chunks 
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES app_users(id) ON DELETE CASCADE;

-- 9. Modify 'licensing' table
ALTER TABLE licensing 
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES app_users(id) ON DELETE CASCADE;

-- 10. Modify 'settings' table: user_id is the primary key (1 row per user)
ALTER TABLE settings 
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES app_users(id) ON DELETE CASCADE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE table_name = 'settings' AND constraint_type = 'PRIMARY KEY'
    ) THEN
        ALTER TABLE settings DROP CONSTRAINT settings_pkey;
    END IF;
    ALTER TABLE settings ADD PRIMARY KEY (user_id);
EXCEPTION
    WHEN others THEN NULL;
END $$;

-- 11. Modify 'transcript_settings' table: user_id is the primary key (1 row per user)
ALTER TABLE transcript_settings 
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES app_users(id) ON DELETE CASCADE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE table_name = 'transcript_settings' AND constraint_type = 'PRIMARY KEY'
    ) THEN
        ALTER TABLE transcript_settings DROP CONSTRAINT transcript_settings_pkey;
    END IF;
    ALTER TABLE transcript_settings ADD PRIMARY KEY (user_id);
EXCEPTION
    WHEN others THEN NULL;
END $$;

-- 12. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_meetings_user_id ON meetings(user_id);
CREATE INDEX IF NOT EXISTS idx_meetings_user_created ON meetings(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transcripts_user_id ON transcripts(user_id);
CREATE INDEX IF NOT EXISTS idx_meeting_notes_user_id ON meeting_notes(user_id);
CREATE INDEX IF NOT EXISTS idx_summary_processes_user_id ON summary_processes(user_id);
CREATE INDEX IF NOT EXISTS idx_transcript_chunks_user_id ON transcript_chunks(user_id);

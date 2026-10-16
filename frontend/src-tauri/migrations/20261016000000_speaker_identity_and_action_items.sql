-- ==============================================================================
-- CrestMeet Speaker Identity, Late-Binding & Action Items Migration
-- Reference: SPEAKER_IDENTITY_AND_ASSIGNMENT_PLAN.md (Sections 6 & 13.3)
-- ==============================================================================

-- 1. Real-World People (Linked to app user_id if registered, or external attendee)
CREATE TABLE IF NOT EXISTS people (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE,                       -- NULL for external attendees, set for app users
    display_name TEXT NOT NULL,
    email TEXT,
    aliases TEXT[] NOT NULL DEFAULT '{}',      -- 'Dave', 'David A.'; used for text-only matches
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_people_user_id ON people(user_id);
CREATE INDEX IF NOT EXISTS idx_people_email ON people(email);

-- 2. Meeting Speakers (One row per diarized speaker cluster per meeting)
CREATE TABLE IF NOT EXISTS meeting_speakers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    cluster_key TEXT NOT NULL,                 -- 'mic:S0', 'sys:S1', 'sys:S2'
    channel TEXT NOT NULL CHECK (channel IN ('mic', 'system')),
    person_id UUID REFERENCES people(id) ON DELETE SET NULL, -- NULL until resolved
    display_name TEXT,
    name_source TEXT CHECK (name_source IN ('manual', 'channel', 'voice_profile', 'ui_automation', 'ocr', 'text_cue')),
    name_confidence REAL,
    suggested_name TEXT,                       -- shown as a chip when not committed
    embedding REAL[],                          -- cluster centroid
    embedding_model TEXT,                      -- model ID used for diarization
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (meeting_id, cluster_key)
);

CREATE INDEX IF NOT EXISTS idx_speakers_meeting ON meeting_speakers(meeting_id);
CREATE INDEX IF NOT EXISTS idx_speakers_person ON meeting_speakers(person_id);

-- 3. Opt-in Voice Profiles
CREATE TABLE IF NOT EXISTS voice_profiles (
    person_id UUID PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    embedding REAL[] NOT NULL,
    n_samples INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Extend Transcripts with Speaker Attribution
ALTER TABLE transcripts
    ADD COLUMN IF NOT EXISTS speaker_id UUID REFERENCES meeting_speakers(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS speaker_confidence REAL;

CREATE INDEX IF NOT EXISTS idx_transcripts_speaker ON transcripts(speaker_id);

-- 5. Extend Meeting Insights with Late-Binding Assigner & Assignee IDs
ALTER TABLE meeting_insights
    ADD COLUMN IF NOT EXISTS assigner_speaker_id UUID REFERENCES meeting_speakers(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS assignee_speaker_id UUID REFERENCES meeting_speakers(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS assignee_person_id UUID REFERENCES people(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS assignee_text_only TEXT,
    ADD COLUMN IF NOT EXISTS assignment_type TEXT CHECK (assignment_type IN ('delegated', 'volunteered', 'proposed_unconfirmed', 'unassigned')),
    ADD COLUMN IF NOT EXISTS confidence REAL,
    ADD COLUMN IF NOT EXISTS evidence_turn_ids TEXT[],
    ADD COLUMN IF NOT EXISTS due_phrase TEXT,
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS user_edited BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS dedupe_key TEXT,
    ADD COLUMN IF NOT EXISTS speaker_unresolved BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_insights_assignee_speaker ON meeting_insights(assignee_speaker_id);
CREATE INDEX IF NOT EXISTS idx_insights_assigner_speaker ON meeting_insights(assigner_speaker_id);
CREATE INDEX IF NOT EXISTS idx_insights_assignee_person ON meeting_insights(assignee_person_id);
CREATE INDEX IF NOT EXISTS idx_insights_status_due ON meeting_insights(type, status, due_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_action_item_dedupe ON meeting_insights (meeting_id, dedupe_key) WHERE type = 'action_item' AND dedupe_key IS NOT NULL;

-- 6. Late-Bound Read View: action_items_resolved
-- Resolves assigner and assignee at query time from people and meeting_speakers
CREATE OR REPLACE VIEW action_items_resolved AS
SELECT mi.id, mi.meeting_id, mi.project_id,
       m.title AS meeting_title, COALESCE(m.created_at, mi.created_at) AS meeting_date,
       mi.content AS task, mi.due_date, mi.due_phrase,
       mi.status, mi.assignment_type, mi.confidence,
       mi.start_seconds, mi.evidence_turn_ids,
       mi.completed_at, mi.updated_at, mi.created_at,
       mi.assignee_speaker_id, mi.assigner_speaker_id,
       ae_p.id      AS assignee_person_id_resolved,
       ae_p.user_id AS assignee_user_id,
       COALESCE(ae_p.display_name, ae.display_name, mi.assignee_text_only, mi.owner_name, ae.cluster_key, 'Unassigned') AS assignee_label,
       ar_p.user_id AS assigner_user_id,
       COALESCE(ar_p.display_name, ar.display_name, ar.cluster_key) AS assigner_label,
       mi.speaker_unresolved,
       mi.user_edited
FROM meeting_insights mi
JOIN meetings m                 ON m.id = mi.meeting_id
LEFT JOIN meeting_speakers ae   ON ae.id = mi.assignee_speaker_id
LEFT JOIN meeting_speakers ar   ON ar.id = mi.assigner_speaker_id
LEFT JOIN people ae_p           ON ae_p.id = COALESCE(ae.person_id, mi.assignee_person_id)
LEFT JOIN people ar_p           ON ar_p.id = ar.person_id
WHERE mi.type = 'action_item';

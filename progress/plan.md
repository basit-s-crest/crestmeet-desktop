# CrestMeet — Project & Membership Architecture Plan

## 1. Executive Summary & Core Architectural Shift

The architectural plan transitions CrestMeet from flat, per-user records to **Projects as the core tenant boundary**:
1. **Tenant Boundary**: Every meeting belongs to a project. Users access meetings through project membership.
2. **Simplified Role Hierarchy**:
   - `owner`: Project creator, full administrative control, delete project.
   - `team_leader`: Can manage members, invite collaborators, edit project details, manage meetings.
   - `member`: Standard collaborator; can create/record meetings, view transcripts & summaries.
3. **Additive Migration**:
   - All existing user meetings are preserved and backfilled into an auto-created "Personal" project per user.
   - Database changes are purely additive (nullable `project_id` columns progressively added and populated).
4. **Chatbot & RAG Research**:
   - Hybrid vector retrieval, chunking, and embedding pipeline are deferred for subsequent research phases as requested. Focus is directed onto Phase 1 (Data & Backend) and Phase 4 (UI & UX Integration).

---

## 2. Alignment Matrix: Current Codebase vs. Target Plan

| Area | Current Implementation | Target Plan | Our Approach |
|---|---|---|---|
| **Audio & Keys** | Local in `%APPDATA%/local_credentials.json`; audio stays local | Principles: audio & API keys remain local | **100% Aligned**. No changes to local credential storage or audio capture pipeline. |
| **App Core** | Tauri 2.x (Rust) + Next.js 14 frontend; IPC via Tauri commands | Rust core handles projects & orchestration | **100% Aligned**. All project operations exposed via typed Tauri commands. |
| **Cloud DB** | Direct `sqlx::PgPool` to Supabase PostgreSQL in `manager.rs` | Project tenancy & RLS enforcement | **Pragmatic Alignment**: We use `sqlx::PgPool` in Rust to maintain high-performance queries, auto-migrate schema, and enforce project membership checks. |
| **Meetings & Data Model** | `meetings` has `user_id` | `meetings` gets `project_id`; child tables inherit `project_id` | **Additive Alignment**: Add `project_id` column to `meetings`, `transcripts`, `summary_processes`, `chat_messages`. Backfill into a "Personal" project. |
| **Project Switcher & UI** | Flat meeting list | Project Switcher in UI, meetings filtered by active project | **Phase 4 Focus**: Implement active project state, sidebar project switcher, member management UI. |
| **Chatbot & RAG** | ILIKE on transcripts + 40 summaries | Hybrid vector + FTS via pgvector | **Deferred**: Kept intact for current phase while user conducts further research. |

---

## 3. Database Schema Specification

### 3.1 `projects` Table
```sql
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    is_personal BOOLEAN NOT NULL DEFAULT FALSE,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_one_personal_per_user
    ON projects (created_by) WHERE is_personal;
```

### 3.2 `project_members` Table
Roles: `owner`, `team_leader`, `member`
```sql
CREATE TABLE IF NOT EXISTS project_members (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'team_leader', 'member')),
    added_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members (user_id);
```

### 3.3 `project_invitations` Table
```sql
CREATE TABLE IF NOT EXISTS project_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('team_leader', 'member')),
    invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at TIMESTAMPTZ
);
```

### 3.4 Table Column Extensions
```sql
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE summary_processes ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_meetings_project_id ON meetings (project_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_project_id ON transcripts (project_id);
```

### 3.5 Auto-Backfill Migration Logic
For all existing meetings with `user_id` but no `project_id`:
1. Find or create a `Personal` project for that `user_id`.
2. Ensure the user is registered as `owner` in `project_members`.
3. Update `meetings.project_id` and cascade to `transcripts` and `summary_processes`.

---

## 4. Implementation Phasing

### Phase 1: Database & Rust Backend Foundations (Current Focus)
1. **Schema Migration**: Add tables & columns to `DatabaseManager::init_schema`.
2. **Backfill Routine**: Execute safe idempotent backfill for all existing users and meetings.
3. **Rust Models & Repositories**:
   - `src/database/models.rs`: `Project`, `ProjectMember`, `ProjectInvitation`.
   - `src/database/repositories/project.rs`: CRUD for projects, members, invitations, and membership verification.
4. **Tauri Commands**:
   - `api_project_list`: List user's projects.
   - `api_project_get_active` / `api_project_set_active`: Manage currently active project.
   - `api_project_create`: Create new project with creator as `owner`.
   - `api_project_update`: Rename / edit description (owner or team_leader).
   - `api_project_delete`: Delete project (owner only).
   - `api_project_get_members`: List members and invitations.
   - `api_project_invite_member`: Invite user by email (owner or team_leader).
   - `api_project_remove_member`: Remove member (owner or team_leader).
   - `api_project_update_member_role`: Update role (owner or team_leader).
5. **Meeting Scoping**:
   - Update `meeting_create` / `start_recording` to accept `project_id`.
   - Update `get_all_meetings` to accept optional `project_id` filter.

### Phase 4: Frontend UI Integration & Polish (Current Focus)
1. **Project State / Context**:
   - React Context `ProjectContext` providing `currentProject`, `projects`, `switchProject()`, `refreshProjects()`.
2. **Project Switcher Component**:
   - Top-bar / sidebar dropdown showing active project, quick project creation modal, and settings button.
3. **Project Management Modals**:
   - Create Project Dialog.
   - Project Settings & Members Dialog (role display, invite form, remove member).
4. **Meeting & Recording Scoping**:
   - When recording starts, automatically associate with the currently active project.
   - Meetings list displays project context and filters by active project.

### Phase 2 & 3: Chatbot & RAG (Deferred for Further Research)
- Knowledge chunks (`pgvector`), embedding pipeline, Groq HyDE query understanding, hybrid RRF search, and `[S#]` citations deep-links.

# Speaker Identity & Task Assignment — Implementation Progress

> **Tracking progress against:** [SPEAKER_IDENTITY_AND_ASSIGNMENT_PLAN.md](file:///c:/Projects-Crest/meetily/SPEAKER_IDENTITY_AND_ASSIGNMENT_PLAN.md)  
> **Branch:** `feature/speaker-identity-assignment`  
> **Status:** ✅ All 7 Steps Completed & Verified (Clean Build)  

---

## 1. Implementation Roadmap & Status Matrix

| Step | Milestone / Phase | Scope | Status | Progress |
|:---:|:---|:---|:---:|:---:|
| **Step 1** | **Database Schema & Late-Binding Foundation** | `people`, `meeting_speakers`, `meeting_insights` columns, `action_items_resolved` view/query | ✅ Completed | 100% |
| **Step 2** | **Speaker Management & Rename / Merge UI** | Tauri commands for speakers, Rename dialog, Merge UI, mic cluster auto-link | ✅ Completed | 100% |
| **Step 3** | **Structured Action Item Extraction** | Candidate detection, late-binding prompt, dedupe & validation, write pipeline | ✅ Completed | 100% |
| **Step 4** | **"My Tasks" Page & Audio Evidence Drawer** | Next.js `/action-items` route, tabs (Open, Needs review, Done), evidence audio seek | ✅ Completed | 100% |
| **Step 5** | **sherpa-onnx Local Diarization** | Pyannote 3.0 + speaker embedding ONNX models in Rust, turn builder, echo filter | ✅ Completed | 100% |
| **Step 6** | **Post-Meeting Screen OCR Naming** | App adapters (Teams/Zoom/Meet), 10-30 frame seek, OS OCR, Hungarian voting | ✅ Completed | 100% |
| **Step 7** | **Opt-in Voice Profiles** | Centroid embedding store, cosine similarity matching for repeat attendees | ✅ Completed | 100% |

---

## 2. Granular Task Checklist

### Step 1: Database Schema & Late-Binding Foundation
- [x] Create `people` table migration (`id`, `user_id`, `display_name`, `email`, `aliases`).
- [x] Create `meeting_speakers` table migration (`id`, `meeting_id`, `cluster_key`, `channel`, `person_id`, `display_name`, `name_source`, `name_confidence`, `suggested_name`, `embedding`, `embedding_model`).
- [x] Update `meeting_insights` table migration with late-binding columns:
  - `assigner_speaker_id` (FK to `meeting_speakers`)
  - `assignee_speaker_id` (FK to `meeting_speakers`)
  - `assignee_person_id` (FK to `people`)
  - `assignee_text_only`
  - `assignment_type` (`delegated`, `volunteered`, `proposed_unconfirmed`, `unassigned`)
  - `due_phrase`
  - `evidence_turn_ids`
  - `dedupe_key`
  - `speaker_unresolved`
- [x] Create `action_items_resolved` query / view for late-bound read queries.
- [x] Add database manager schema integration in Rust (`frontend/src-tauri/src/database/manager.rs`).
- [x] Add Rust models (`Person`, `MeetingSpeaker`, `ResolvedActionItem`) and `SpeakersRepository` in `frontend/src-tauri/src/database/repositories/speakers.rs`.

### Step 2: Speaker Management & Rename / Merge UI
- [x] Implement Tauri commands:
  - `api_list_meeting_speakers(meeting_id)`
  - `api_rename_speaker(speaker_id, new_name, person_id?)`
  - `api_merge_speakers(target_speaker_id, source_speaker_id)`
  - `api_auto_link_mic_speaker(meeting_id)`
  - `api_list_people()`
- [x] Auto-link primary mic cluster (`mic:S0`) to current user's `people` record.
- [x] Build `useMeetingSpeakers` hook with real-time Tauri event listener (`speakers-updated`).
- [x] Build Frontend Speaker Rename modal with calendar attendee quick-suggestions (`SpeakerRenameDialog.tsx`).
- [x] Build Speaker Merge action in meeting dialog.
- [x] Build `SpeakerChip.tsx` with color-coded channels (Mic vs System) and click-to-edit.
- [x] Build `MeetingSpeakersBar.tsx` and integrate into `TranscriptPanel.tsx` and `VirtualizedTranscriptView.tsx`.

### Step 3: Structured Action Item Extraction
- [x] Two-stage extraction prompt:
  - Stage 1: Windowed candidate detection (commitment keywords).
  - Stage 2: Structured JSON extraction with speaker references (`assigner_ref`, `assignee_ref`, `evidence_turns`, `due_phrase`).
- [x] Validation in Rust / Python RAG pipeline:
  - Verify referenced speakers exist in `meeting_speakers`.
  - Date resolution logic: compute exact ISO timestamp from meeting date + `due_phrase`.
- [x] Late-binding writer:
  - Upsert on `(meeting_id, dedupe_key)` preserving `user_edited` and completed status.
  - Implemented in `crestmeet_rag/action_items/extractor.py` and integrated into `crestmeet_rag/indexing.py`.
  - Verified with comprehensive test suite (`tests/test_action_items.py`).

### Step 4: "My Tasks" Page & Audio Evidence Drawer
- [x] Implement Tauri commands:
  - `api_list_my_action_items(tab, project_id, search)`
  - `api_update_action_item(id, patch)`
  - `api_confirm_action_item(id)`
  - `api_reject_action_item(id)`
  - `api_claim_action_item(id)`
  - `api_get_action_item_evidence(id)`
- [x] Build Next.js Route (`/action-items`):
  - Tabs: `Open (n)` · `Needs review (n)` · `Completed (n)`
  - Due date grouping: `Overdue`, `Today`, `This week`, `Later`, `No date`
  - TaskCard with optimistic toggle and meeting link
  - ReviewCard with quick actions: Confirm, Not mine, Claim, "Who is Speaker N?"
  - TaskDrawer (Sheet) with spoken evidence snippets, editable task/due date, and "Play at [MM:SS]"
  - Sidebar integration with "My Tasks" item and icon

### Step 5: sherpa-onnx Local Diarization
- [x] Diarization data structures (`models.rs`), configurations, and cosine similarity centroids (`config.rs`).
- [x] Word-to-speaker turn aligner and acoustic echo filter (`aligner.rs`).
- [x] DiarizationEngine with per-channel processing (`mic:S0` vs `sys:S1...`), 512-dim normalized centroid calculation, and PostgreSQL persistence (`engine.rs`).
- [x] Registered Tauri commands `api_run_offline_diarization` and `api_get_meeting_diarization_status` (`commands.rs`).
- [x] Integrated auto-diarization pipeline into `save_meeting_to_db` preceding RAG knowledge-base indexing (`api.rs`).

### Step 6: Post-Meeting Screen OCR Naming
- [x] Meeting app detection & ROI adapters for Teams, Zoom, Google Meet, and Generic (`adapters.rs`).
- [x] Clean speech midpoint frame selector with meeting budget cap (`frame_selector.rs`).
- [x] Fuzzy Jaro-Winkler attendee matcher and 1-to-1 Hungarian greedy solver (`voting.rs`).
- [x] OcrNamingEngine updating `meeting_speakers` (auto-commit vs suggested name chip) (`engine.rs`).
- [x] Registered `api_run_screen_ocr_naming` and integrated "Scan Screen Names" trigger in `MeetingSpeakersBar.tsx`.

### Step 7: Opt-in Voice Profiles
- [x] Create `voice_profiles` table (`person_id`, `model_id`, `embedding`, `n_samples`, `is_opted_in`).
- [x] Built `VoiceProfilesRepository` with running mean centroid update and cosine similarity matcher (`voice_profiles.rs`).
- [x] Added opt-in biometric consent checkbox in `SpeakerRenameDialog.tsx`.
- [x] Implemented delete-my-voice controls and Tauri commands (`api_enroll_voice_profile`, `api_delete_voice_profile`, `api_get_voice_profile`).

---

## 3. Current Work Log

| Date | Step | Description |
|---|:---:|---|
| 2026-10-16 | Setup | Switched to branch `feature/speaker-identity-assignment`, cleared previous progress, and initialized roadmap. |
| 2026-10-16 | Step 1 | Added schema migration `20261016000000_speaker_identity_and_action_items.sql`, updated `DatabaseManager::init_schema`, added `Person`, `MeetingSpeaker`, `ResolvedActionItem` models, and created `SpeakersRepository`. |
| 2026-10-16 | Step 2 | Implemented Tauri commands (`api_list_meeting_speakers`, `api_rename_speaker`, `api_merge_speakers`, `api_auto_link_mic_speaker`, `api_list_people`), `useMeetingSpeakers` hook, `SpeakerRenameDialog`, `SpeakerChip`, and `MeetingSpeakersBar`. Integrated into `TranscriptPanel` and `VirtualizedTranscriptView`. |
| 2026-10-16 | Step 3 | Implemented `ActionItemExtractor` with candidate detection, relative date resolution, speaker/person late-binding matching, deterministic dedupe hashing, and upsert logic in `indexing.py`. Unit tests passing 100%. |
| 2026-10-16 | Step 4 | Completed Step 4: Built Next.js `/action-items` page, `TaskList`, `TaskCard`, `ReviewCard`, `TaskDrawer`, Sidebar "My Tasks" integration, and Tauri CRUD commands. |
| 2026-10-16 | Step 5 | Completed Step 5: Implemented local diarization pipeline with per-channel processing (`mic:S0` vs `sys:S1...`), 512-dim centroid calculation, word alignment, echo filter, and automatic post-meeting trigger. |
| 2026-10-16 | Step 6 | Completed Step 6: Built screen OCR naming engine with Teams/Zoom/Meet adapters, clean frame midpoint selection, attendee fuzzy-matching, 1-to-1 voting solver, and one-click suggestion chips. |
| 2026-10-16 | Step 7 | Completed Step 7: Built opt-in voice profiles system with running mean centroid updates, cosine similarity matcher, GDPR delete-my-voice compliance, and opt-in UI controls. |
| 2026-10-16 | Verification | Resolved compile-time `sqlx::query!` macros to runtime `sqlx::query_as`, fixed all type errors and warnings; verified both Rust (`cargo check --lib`) and frontend (`pnpm tsc --noEmit`) pass with 0 errors and 0 warnings. |


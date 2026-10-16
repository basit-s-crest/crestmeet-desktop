# Speaker Identity & Task Assignment — Implementation Progress

> **Tracking progress against:** [SPEAKER_IDENTITY_AND_ASSIGNMENT_PLAN.md](file:///c:/Projects-Crest/meetily/SPEAKER_IDENTITY_AND_ASSIGNMENT_PLAN.md)  
> **Branch:** `feature/speaker-identity-assignment`  
> **Status:** In Progress — Step 1 Started  

---

## 1. Implementation Roadmap & Status Matrix

| Step | Milestone / Phase | Scope | Status | Progress |
|:---:|:---|:---|:---:|:---:|
| **Step 1** | **Database Schema & Late-Binding Foundation** | `people`, `meeting_speakers`, `meeting_insights` columns, `action_items_resolved` view/query | ✅ Completed | 100% |
| **Step 1** | **Database Schema & Late-Binding Foundation** | `people`, `meeting_speakers`, `meeting_insights` columns, `action_items_resolved` view/query | ✅ Completed | 100% |
| **Step 2** | **Speaker Management & Rename / Merge UI** | Tauri commands for speakers, Rename dialog, Merge UI, mic cluster auto-link | ✅ Completed | 100% |
| **Step 3** | **Structured Action Item Extraction** | Candidate detection, late-binding prompt, dedupe & validation, write pipeline | 🟡 In Progress | 20% |
| **Step 4** | **"My Tasks" Page & Audio Evidence Drawer** | Next.js `/action-items` route, tabs (Open, Needs review, Done), evidence audio seek | ⏳ Queued | 0% |
| **Step 5** | **sherpa-onnx Local Diarization** | Pyannote 3.0 + speaker embedding ONNX models in Rust, turn builder, echo filter | ⏳ Queued | 0% |
| **Step 6** | **Post-Meeting Screen OCR Naming** | App adapters (Teams/Zoom/Meet), 10-30 frame seek, OS OCR, Hungarian voting | ⏳ Queued | 0% |
| **Step 7** | **Opt-in Voice Profiles** | Centroid embedding store, cosine similarity matching for repeat attendees | ⏳ Queued | 0% |

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
- [ ] Two-stage extraction prompt:
  - Stage 1: Windowed candidate detection (commitment keywords).
  - Stage 2: Structured JSON extraction with speaker references (`assigner_ref`, `assignee_ref`, `evidence_turns`, `due_phrase`).
- [ ] Validation in Rust / Python RAG pipeline:
  - Verify referenced speakers exist in `meeting_speakers`.
  - Date resolution logic: compute exact ISO timestamp from meeting date + `due_phrase`.
- [ ] Late-binding writer:
  - Upsert on `(meeting_id, dedupe_key)` preserving `user_edited` and completed status.

### Step 4: "My Tasks" Page & Audio Evidence Drawer
- [ ] Implement Tauri commands:
  - `api_list_my_action_items(filters, cursor)`
  - `api_list_action_items_needing_review()`
  - `api_update_action_item(id, patch)`
  - `api_confirm_action_item(id)`
  - `api_reject_action_item(id)`
  - `api_claim_action_item(id)`
  - `api_get_action_item_evidence(id)`
- [ ] Build Next.js Route (`/action-items`):
  - Tabs: `Open` · `Needs review` · `Done`
  - Due date grouping: `Overdue`, `Today`, `This week`, `Later`, `No date`
  - Evidence Drawer with quote, speaker label, and "Play audio from [MM:SS]"
  - Review Card Actions: Confirm, Not mine, Claim, "Who is Speaker N?"

### Step 5: sherpa-onnx Local Diarization
- [ ] Integrate `sherpa-onnx` runtime in Rust / Tauri.
- [ ] Download / package ONNX models:
  - Pyannote segmentation 3.0 ONNX.
  - Speaker embedding model (3D-Speaker / WeSpeaker).
- [ ] Post-meeting background worker:
  - Run channel-separated diarization (`mic` vs `system`).
  - Word-to-speaker turn alignment with word timestamps from ASR.
  - Echo cancellation / text overlap filter.
  - Persist cluster centroids in `meeting_speakers`.

### Step 6: Post-Meeting Screen OCR Naming
- [ ] Meeting app detection (Teams, Zoom, Google Meet).
- [ ] Window adapters (bounding boxes / ROIs for active speaker tags).
- [ ] Frame selector: seek to 10–30 clean speech midpoints from video file.
- [ ] Native OS OCR execution (`Windows.Media.Ocr`).
- [ ] Normalization, fuzzy-matching against calendar attendees, Hungarian voting.
- [ ] One-click name suggestion chips when confidence is sub-threshold.

### Step 7: Opt-in Voice Profiles
- [ ] Create `voice_profiles` table (`person_id`, `model_id`, `embedding`, `n_samples`).
- [ ] Opt-in privacy settings & delete-my-voice controls.
- [ ] Cosine similarity matcher across meeting attendees.

---

## 3. Current Work Log

| Date | Step | Description |
|---|:---:|---|
| 2026-10-16 | Setup | Switched to branch `feature/speaker-identity-assignment`, cleared previous progress, and initialized roadmap. |
| 2026-10-16 | Step 1 | Added schema migration `20261016000000_speaker_identity_and_action_items.sql`, updated `DatabaseManager::init_schema`, added `Person`, `MeetingSpeaker`, `ResolvedActionItem` models, and created `SpeakersRepository`. |
| 2026-10-16 | Step 2 | Implemented Tauri commands (`api_list_meeting_speakers`, `api_rename_speaker`, `api_merge_speakers`, `api_auto_link_mic_speaker`, `api_list_people`), `useMeetingSpeakers` hook, `SpeakerRenameDialog`, `SpeakerChip`, and `MeetingSpeakersBar`. Integrated into `TranscriptPanel` and `VirtualizedTranscriptView`. |
| 2026-10-16 | Step 3 | Commenced Step 3: Structured Action Item Extraction with late-binding assigner/assignee references, candidate detection, and dedupe writer. |

# Architecture & Implementation Plan: Multi-User Collaboration & P2P Media Sharing (Approach B)

## 1. Executive Summary & Vision
As **Meetily** evolves from a single-user local desktop recorder into a collaborative, multi-user workspace, teams (e.g. 4+ members) need to share projects, review meeting notes, and inspect recordings.

This plan details:
1. **Multi-User Data Segregation**: What syncs to the cloud vs. what stays local on device.
2. **On-Demand P2P Media Sharing (Approach B - 100% Free)**: How teammates can request and receive large video/audio recordings directly from the recorder's laptop without incurring cloud storage costs.
3. **Cross-Access Permissions & Deletion Lifecycle**: How project and meeting deletions are safely handled across multiple users.
4. **Step-by-Step Implementation Roadmap**: Technical tasks across backend (Rust/Tauri), database (PostgreSQL/Supabase), and frontend (Next.js/React).

---

## 2. Multi-User Architecture: Cloud Data vs. Local Media

### A. What Syncs in the Cloud (PostgreSQL / Supabase)
All textual, metadata, and intelligence assets are lightweight and stored centrally in the shared database:
- **Projects & Members**: Roles (`owner`, `team_leader`, `member`), invitations, timestamps.
- **Meetings Metadata**: Meeting ID, title, created timestamp, duration, project mapping.
- **Transcripts**: Full diarized transcript segments and timestamps.
- **AI Intelligence**: Summaries, key decisions, action items, process states.
- **Team Notes & Chat**: Collaborative meeting notes and AI assistant chat history.

> **Result:** When User A records a meeting, Users B, C, and D can immediately see the meeting in the project, read the full transcript, review AI summaries, and ask questions to the chatbot.

### B. What Stays on the Local Machine
Raw audio and screen recordings are heavy binary files (typically **100MB to 1.5GB** per hour):
- High-fidelity system audio (`.wav`)
- Microphone capture (`.wav`)
- Screen recording video (`.mp4` / `.webm`)
- Storage location: Local app data directory (e.g. `%APPDATA%\crestmeet\recordings\<meeting_id>\`)

### C. The Multi-User Media Dilemma
- When User A records, the database stores `folder_path = "C:\Users\UserA\AppData\..."`.
- When User B opens the meeting on their machine, their app searches for `C:\Users\UserA\...` on **User B's disk**, which does not exist.
- Therefore:
  - User A has full playback capabilities.
  - Users B, C, and D have instant access to text/summaries, but see a placeholder for video playback.

---

## 3. The Solution: Approach B — Direct Peer-to-Peer (P2P) On-Demand Transfer

### Why Approach B?
- **Zero Cloud Storage Bills ($0/month)**: Video and audio files never pass through or get stored in expensive cloud buckets (S3, Supabase Storage, or R2).
- **No Third-Party Messaging Apps**: Users do not need WhatsApp, Slack, or email; everything happens natively inside Meetily.
- **Complete Enterprise Privacy**: Media transfers are end-to-end encrypted directly between the two peer machines.
- **Unlimited File Size**: Bypasses WhatsApp's 16MB/100MB limits entirely.

---

## 4. P2P On-Demand Transfer: End-to-End Workflow

```
[User B: Requesting Teammate]                         [User A: Original Recorder]
           │                                                      │
1. Opens Meeting Details                                          │
   - Reads transcript & summary                                   │
   - Player displays:                                             │
     "Video stored on User A's device"                            │
   - Clicks [Request Recording]                                   │
           │                                                      │
           ├────────────(1. Write to media_requests)──────────────>│
           │                                                      │
           │                                          2. In-App Notification Pops Up:
           │                                             "User B requested video for
           │                                              'Sprint Review'. [Send] [Decline]"
           │                                          3. Clicks [Send Video]
           │                                                      │
           │<═══════════(2. WebRTC P2P Handshake / Signaling)════>│
           │                                                      │
           │<═══════════(3. Direct Encrypted Binary Stream)═══════│
           │   (Reads local .mp4 in chunks -> Sends P2P)          │
4. Receives chunks & writes                                       │
   to local Meetily folder                                        │
5. Player unlocks automatically!                                  │
   User B can now watch locally                                   │
```

### Detailed Flow:
1. **Request Trigger (User B)**:
   - In `MeetingVideoPlayer`, if the local file is not present, User B sees:
     *"Recording is stored on [Recorder Name]'s device."*
     `[ Request Video Recording ]`
   - Clicking the button inserts a record in `media_requests` with status `pending`.

2. **Notification & Approval (User A)**:
   - When User A has Meetily open, Supabase Realtime notifies them:
     *"User B requested the recording for 'Project Planning'. Would you like to send it?"*
   - User A has two options: **[ Send Recording ]** or **[ Decline ]**.

3. **Direct P2P Handshake (Signaling via Supabase)**:
   - Supabase Realtime acts strictly as the **signaling server** (exchanging SDP offer/answer and ICE candidates).
   - Zero media bytes touch Supabase; only tiny JSON connection signals (~2KB) are exchanged.

4. **Encrypted Chunked Transfer**:
   - Meetily establishes a direct **WebRTC DataChannel**.
   - User A's Tauri backend reads the `.mp4` / audio file in 64KB binary chunks and streams it over the DataChannel.
   - User B's Tauri backend receives chunks and writes them directly into:
     `%APPDATA%\crestmeet\recordings\<meeting_id>\video.mp4`
   - Both users see a sleek real-time progress bar: `Transferring: 45% (12 MB/s)`.

5. **Local Unlocking**:
   - Once transfer finishes, `meetings.folder_path` on User B's device updates to their local directory.
   - User B can now watch, scrub, and replay the video locally at any time, even offline.

---

## 5. Deletion & Data Lifecycle in Multi-User Workspaces

### A. How Delete Works Today (Baseline)
1. **Project Deletion**:
   - `DELETE FROM projects WHERE id = $project_id`.
   - Database cascades (`ON DELETE CASCADE`) delete all:
     - `project_members`
     - `project_invitations`
     - `transcripts`
     - `summary_processes`
     - `chat_messages`
   - **Local File Safety Guarantee**: The SQL query does **not** touch the user's hard drive. All raw `.wav` and `.mp4` recordings remain safely stored locally on the recorder's machine.
2. **Single Meeting Deletion**:
   - `api_delete_meeting` deletes database rows (`transcripts`, `summary_processes`, `meeting_notes`, `meetings`).
   - Disk files remain in the local folder.

### B. Multi-User Permissions & Safeguards
When multiple users collaborate in a single project:

| Action | Allowed Role | Target Affected | Local Disk Files |
| :--- | :--- | :--- | :--- |
| **Archive Project** | **Owner** only | Moved to Archived tab for all members | Safe on disk |
| **Delete Project** | **Owner** only (Must be archived first) | Permanently purged from cloud DB for all members | Safe on disk of recorder |
| **Delete Meeting** | **Recorder** OR **Project Owner** | Deleted from cloud DB for all members | Recorder's local files moved to Trash / Recycled |
| **Edit Meeting Title** | All Project Members | Synced in cloud DB | Folder name unchanged |
| **Request Media** | All Project Members | Creates P2P transfer request | N/A |

#### Scenario 1: What happens to User B, C, and D when Owner deletes a project?
- The project is deleted from the central PostgreSQL database.
- On next sync or page switch, Users B, C, and D no longer see the project in their `Projects` list.
- If User B was currently looking at that project, the app gracefully redirects them to their overview with a toast notification: *"This project was deleted by the owner."*
- **Local recordings safety**: Any meetings recorded by User A or User B on their respective laptops remain intact in their local app data.

#### Scenario 2: Guarding Meeting Deletion
- Currently, anyone with the meeting ID could invoke `api_delete_meeting`.
- **New Safeguard**: The Tauri command `api_delete_meeting` must verify that the requesting user is either:
  1. The **creator/recorder** of the meeting (`meeting.user_id == current_user.id`), OR
  2. The **Project Owner** (`project_members.role == 'owner'`).
- Ordinary members cannot delete meetings recorded by teammates.

---

## 6. Implementation Roadmap & Step-by-Step Execution Plan

### Step 1: Database Migration for Media Requests & Deletion Guards
- [ ] Add `media_requests` table in `src-tauri/src/database/manager.rs`:
  ```sql
  CREATE TABLE IF NOT EXISTS media_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      requested_by UUID NOT NULL,       -- User B
      recorder_id UUID NOT NULL,        -- User A
      media_type TEXT NOT NULL DEFAULT 'video', -- 'video' | 'audio'
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'transferring', 'completed', 'declined', 'failed')),
      progress INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_media_requests_recorder ON media_requests(recorder_id, status);
  CREATE INDEX IF NOT EXISTS idx_media_requests_meeting ON media_requests(meeting_id);
  ```
- [ ] Add foreign key constraint on `meetings.project_id`: Change `ON DELETE SET NULL` to explicit cascade cleanup if desired, or keep as orphaned archive.

### Step 2: Rust Backend (Tauri) — Deletion Permission Verification
- [ ] In `src-tauri/src/api/api.rs` (`api_delete_meeting`):
  - Retrieve meeting creator `user_id` and project role.
  - Ensure only the meeting creator or project owner can delete the meeting.
  - Return informative error: *"Only the meeting recorder or project owner can delete this meeting"*.

### Step 3: P2P Signaling & Transfer Engine (WebRTC in Tauri/Frontend)
- [ ] **Signaling Mechanism**:
  - Use Supabase Realtime Broadcast channel: `project:media-transfer:<meeting_id>`.
  - Exchange WebRTC Offer, Answer, and ICE candidates between peers.
- [ ] **Chunked File Streaming**:
  - Implement Tauri command `api_start_p2p_file_sender(meeting_id, file_type)` to stream chunks from disk.
  - Implement Tauri command `api_write_p2p_chunk(meeting_id, chunk_bytes)` to write received chunks into User B's local recordings folder.
  - Track byte progress and emit transfer progress events to the UI.

### Step 4: Frontend UI Integration
- [ ] **Requester View (`MeetingVideoPlayer.tsx`)**:
  - Check if local video file exists. If missing:
    - Display: *"Recording is stored on [Recorder Name]'s device."*
    - Show `[ Request Recording ]` button.
    - If request is pending: Show spinner with *"Waiting for [Recorder Name] to accept..."*
    - If transferring: Show animated progress bar `Transferring: X%`.
    - When completed: Video player immediately becomes playable.
- [ ] **Recorder View (`In-App Notification / Dialog`)**:
  - Listen to incoming `media_requests` via Supabase Realtime.
  - Display popup banner:
    > **Recording Request**
    > *Jane Doe requested the video for "Sprint Planning Q4".*
    > `[ Send Video ]` `[ Decline ]`
  - Clicking `[ Send Video ]` starts the P2P transfer in the background without interrupting work.

---

## 7. Edge Cases & Reliability Strategies

### A. Offline Recorder Handling
- **Problem**: User B clicks `[ Request Recording ]`, but User A's laptop is currently off or Meetily is closed.
- **Solution**:
  - The request row stays in `media_requests` with status `pending`.
  - The moment User A launches Meetily, an app-launch check queries:
    `SELECT * FROM media_requests WHERE recorder_id = $my_id AND status = 'pending'`
  - User A is immediately prompted: *"You have 1 pending recording request from Jane Doe"*.

### B. Network NAT Traversal (Free STUN Configuration)
- **Problem**: Employees in different home offices or corporate firewalls need direct P2P connections.
- **Solution**:
  - WebRTC uses free public STUN servers (e.g. Google's free STUN: `stun:stun.l.google.com:19302`) to discover external IP and port mappings.
  - Zero server cost for STUN.
  - In corporate symmetric NATs where direct P2P might fail, transfer falls back to notifying the user with a direct local network export option or retry prompt.

### C. Transfer Interruption & Resumption
- **Problem**: A 700MB video is transferring and User A closes their laptop at 60%.
- **Solution**:
  - Chunks are numbered (`chunk_index` / `total_chunks`).
  - When connection is re-established, User B requests missing chunks starting from `last_received_chunk` rather than starting from 0%, saving bandwidth and time.

---

## 8. Summary of Benefits
1. **Zero Recurring Infrastructure Costs**: No AWS S3, Cloudflare R2, or Supabase Storage bills for heavy videos.
2. **Direct Enterprise-Grade Privacy**: Video travels directly between employees' machines.
3. **Multi-User Harmony**: Instant text/transcript sharing for everyone, with frictionless on-demand media streaming when needed.
4. **Resilient Data Protection**: Clear permission boundaries where owners control project lifecycles, creators control meeting records, and local disk files are protected against accidental cloud purges.


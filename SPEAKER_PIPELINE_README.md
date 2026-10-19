# Speaker Detection, Screen OCR & Task Assignment Pipeline

> **Complete Architecture & Development Strategy Guide**  
> **Repository:** CrestMeet Desktop  
> **Status:** Production-Ready & Verified  

---

## 1. Executive Architecture Overview

In meeting intelligence, answering **"Who is speaking?"** and **"Who owns which action item?"** requires a multimodal fusion of **Audio Diarization**, **Computer Vision (Screen OCR)**, and **Natural Language Processing (LLM Extraction)**.

Instead of relying on fragile single-frame snapshots or hardcoded UI assumptions, CrestMeet connects audio turns, computer vision highlights, and calendar rosters into an automated, late-bound pipeline.

```mermaid
flowchart TD
    subgraph AudioPipeline ["1. Audio & Diarization Engine"]
        A[Dual-Channel Audio Capture] -->|Mic: Local User| B1[Speaker S0 (Pinned)]
        A -->|System Audio: Loopback| B2[Pyannote / WeSpeaker Diarization]
        B2 --> C[Acoustic Speaker Clusters: S1, S2, S3...]
        C --> D[Timestamped Turns: start_ms -> end_ms]
    end

    subgraph VisionPipeline ["2. Computer Vision & Screen OCR"]
        D -->|Query Speech Midpoints| E[Frame Selector: Clean Speech Windows]
        E --> F[Screen Frame Capture]
        F --> G[Color-Agnostic Active Speaker Detection]
        F --> H[RapidOCR ONNX Full-Grid Text Detection]
        G & H --> I[Speaker-to-Tile Bounding Box Correlation]
    end

    subgraph IdentityResolution ["3. Identity & Voting Engine"]
        I --> J[Hungarian 1-to-1 Voting Solver]
        K[Calendar Invite Roster] --> J
        L[Voice Profiles / Historical Centroids] --> J
        J --> M[(meeting_speakers Table)]
        M --> N[(people Table)]
    end

    subgraph TaskPipeline ["4. Action Item Extraction & Late-Binding"]
        D --> O[Two-Stage LLM Task Extractor]
        O --> P[Structured Action Items: assignee_speaker_id = S2]
        P --> Q[(meeting_insights Table)]
        M -.->|Late-Binding SQL View| R[action_items_resolved]
        N -.->|Auto-Links Person| R
        R --> S["Next.js 'My Tasks' Dashboard (/action-items)"]
    end
```

---

## 2. Stage-by-Stage Technical Breakdown

### Stage 1: Dual-Channel Capture & Audio Diarization
* **Channel Separation**:
  * `Mic Channel`: Captures the local user. Automatically pinned to `mic:S0` and linked directly to the authenticated user's `Person` profile.
  * `System Loopback Channel`: Captures remote participants (`sys:S1`, `sys:S2`, ...).
* **Pyannote / WeSpeaker Embedding Extraction**:
  * Breaks audio into continuous speech segments.
  * Extracts 512-dimensional L2-normalized voice embeddings for each turn.
  * Clusters turns into persistent cluster keys (`meeting_speakers`).

---

### Stage 2: Time-Aligned Video Frame Selection at Speech Midpoints
Instead of blindly sampling 30 frames per second:
1. **Targeted Sampling**: The engine inspects each speaker's longest, uninterrupted speech turns (> 2.5 seconds).
2. **Midpoint Capture**: A video frame is captured at the midpoint of the turn ($\text{start} + \frac{\text{duration}}{2}$), when the speaker is actively talking and their video tile is actively highlighted.
3. **Budget Cap**: Samples 3–5 representative frames per speaker cluster to keep processing lightweight.

---

### Stage 3: Color-Agnostic Active Speaker Detection & RapidOCR
Different meeting platforms (Zoom, Teams, Google Meet, Webex) use different highlight border colors and layout modes. The vision engine resolves this universally:

```
[Screen Frame (1920x1080)]
   │
   ├──▶ Color-Agnostic Contour Detection (Saturation & Contrast Edge Profile)
   │     ↳ Discards grayscale backgrounds (S < 40)
   │     ↳ Isolates high-chroma, vibrant border perimeter (Green, Purple, Yellow, Cyan, Blue)
   │     ↳ Finds Active Speaker Tile Rectangle: (x=20, y=250, w=380, h=220)
   │
   ├──▶ RapidOCR (ONNX DBNet + SVTR Recognizer)
   │     ↳ Scans full frame in parallel
   │     ↳ Extracts all text chips with 4-point bounding boxes
   │     ↳ Yields full meeting roster: ["Daniel H.", "Timothy M.", "Penelope W."]
   │
   └──▶ Spatial Intersection (Point-in-Polygon / Tile BBox)
         ↳ Text box [30, 450] falls inside the highlighted tile
         ↳ ACTIVE SPEAKER CONFIRMED: "Timothy Martin"
```

1. **Hue-Agnostic Saturation Filter**:
   Grayscale UI chrome (toolbars, black borders, gray gutters) has saturation $S \approx 0$. Active speaker highlight borders have saturation $S > 50$, regardless of whether the color is Zoom green, Teams purple, or Meet blue.
2. **RapidOCR ONNX Detection**:
   Extracts all participant nameplates across the entire grid in a single pass with sub-pixel bounding box coordinates.
3. **Geometric Binding**:
   The OCR bounding box located in the lower-third of the illuminated active tile is resolved as that speaker turn’s identity.

---

### Stage 4: Hungarian Voting Solver & Speaker Identity Resolution
Single-frame OCR can suffer from occlusion or temporary network drops. To guarantee precision:
1. **Voting Matrix ($N$ frames $\times M$ speakers)**:
   Every frame observation votes for candidate names with confidence weights.
2. **1-to-1 Hungarian Matching**:
   A greedy/bipartite graph solver ensures no two distinct voice clusters (`S1` and `S2`) are assigned the same person's name.
3. **Calendar Roster Matching**:
   Fuzzy Jaro-Winkler comparison aligns OCR text against the meeting's Google/Outlook calendar attendees (`attendees` list).
4. **Database Update**:
   Writes the resolved name and confidence directly into `meeting_speakers`:
   * `display_name = "Timothy Martin"`
   * `name_source = "ocr_auto"`
   * `name_confidence = 0.94`

---

### Stage 5: Structured Action Item Extraction & Late-Binding Assignment

#### The Late-Binding Paradigm
In real meetings, task extraction may finish **before** the user manually confirms or renames a speaker. **Late-binding** prevents hardcoded failures:

1. **Extraction (LLM Prompting)**:
   The LLM does **not** hardcode a person's name into the task. It extracts references to cluster IDs:
   ```json
   {
     "task": "Prepare updated Q3 financial models by Friday",
     "assignee_speaker_id": "speaker_cluster_uuid_S2",
     "assigner_speaker_id": "speaker_cluster_uuid_S1",
     "assignment_type": "volunteered",
     "due_phrase": "by Friday",
     "evidence_turn_ids": ["turn_45", "turn_46"]
   }
   ```
2. **Instant SQL View Resolution (`action_items_resolved`)**:
   Tasks are queried through a relational SQL join:
   ```sql
   CREATE VIEW action_items_resolved AS
   SELECT 
       ai.id,
       ai.task,
       ai.due_date,
       ms.display_name AS assignee_name,
       p.id AS assignee_person_id,
       p.email AS assignee_email
   FROM meeting_insights ai
   LEFT JOIN meeting_speakers ms ON ai.assignee_speaker_id = ms.id
   LEFT JOIN people p ON ms.person_id = p.id;
   ```
3. **Automatic Task Routing**:
   * If `Speaker 2` is initially unnamed, the task appears under **Needs Review** (`"Unassigned / Speaker 2"`).
   * The moment OCR or the user sets `Speaker 2 = Timothy Martin`, **all past and future tasks immediately re-route to Timothy Martin** across the entire database without re-running any LLM prompts.

---

## 3. Database Schema Foundation

### `people` Table
Stores unified identity records across meetings:
* `id` (UUID, Primary Key)
* `user_id` (UUID, Foreign Key to Auth)
* `display_name` (Text)
* `email` (Text, Optional)
* `aliases` (JSON Array of strings, e.g. `["Tim", "Timothy Martin"]`)

### `meeting_speakers` Table
Stores speaker clusters detected per meeting:
* `id` (UUID, Primary Key)
* `meeting_id` (Text, Foreign Key)
* `cluster_key` (Text, e.g. `mic:S0`, `sys:S1`)
* `channel` (`mic` | `sys`)
* `person_id` (UUID, Foreign Key to `people`, Optional)
* `display_name` (Text, e.g. `"Timothy Martin"`)
* `name_source` (`ocr_auto` | `voice_match` | `manual` | `unassigned`)
* `name_confidence` (Float, 0.0 to 1.0)
* `embedding` (512-dim Vector, Optional)

### `meeting_insights` (Action Items) Table
Stores structured action items linked to speakers:
* `id` (UUID, Primary Key)
* `meeting_id` (Text)
* `task` (Text)
* `assigner_speaker_id` (UUID, FK to `meeting_speakers`)
* `assignee_speaker_id` (UUID, FK to `meeting_speakers`)
* `assignee_person_id` (UUID, FK to `people`)
* `assignment_type` (`delegated` | `volunteered` | `proposed_unconfirmed` | `unassigned`)
* `due_date` (Date, e.g. `2026-10-24`)
* `due_phrase` (Text, e.g. `"by Friday"`)
* `evidence_turn_ids` (JSON Array)
* `status` (`open` | `completed` | `dismissed`)

---

## 4. Frontend & User Experience

| UI Component | Path | Function |
| :--- | :--- | :--- |
| **"My Tasks" Dashboard** | `/action-items` | Central task management page featuring tabs: `Open`, `Needs Review`, and `Completed`. Displays audio evidence player seeking directly to the verbal commitment. |
| **Speaker Bar** | Meeting Detail / Transcript | Displays color-coded speaker chips (`Mic: You`, `Sys: Timothy Martin`). Clicking a chip opens the rename and merge modal. |
| **"Scan Screen Names"** | Meeting Detail / Speakers | Manual trigger allowing users to run screen OCR on recorded meeting video if speakers were unresolved. |
| **Speaker Rename Modal** | `SpeakerRenameDialog.tsx` | Allows one-click renaming with calendar attendee suggestions. Propagates changes instantaneously via `action_items_resolved`. |

---

## 5. Failure Resilience & Edge Cases

1. **Silent / Audio-Only Calls (No Video Highlight)**:
   * Fallback: RapidOCR extracts all visible participant tiles (`all_grid_names`), matching against calendar invites and voice embedding centroids.
2. **Dark Mode vs. Light Mode**:
   * Saturation and gradient magnitude detection ensures high contrast lines are caught whether the background is pitch black or light gray.
3. **Low-Latency & Zero Extra API Costs**:
   * RapidOCR runs locally via ONNX Runtime on CPU (< 35ms per frame).
   * Voice embeddings and diarization run fully on-device.
   * Tasks are assigned via deterministic SQL relations without expensive repeat LLM invocations.

# Meetily — Architecture & Technical Overview

> **Privacy-First AI Meeting Assistant** built with **Tauri 2.x (Rust)** and **Next.js 14 (React 18 + TypeScript)**.
> Captures system and microphone audio, transcribes speech in real-time on local hardware, persists data to an embedded SQLite database, and generates structured meeting minutes using local or cloud Large Language Models.

---

## Table of Contents

1. [System Overview & Tech Stack](#1-system-overview--tech-stack)
2. [Repository & Directory Structure](#2-repository--directory-structure)
3. [Architecture & Module Attachment](#3-architecture--module-attachment)
4. [End-to-End Data Flows](#4-end-to-end-data-flows)
   - [4.1 Audio Capture & Real-Time Mixing](#41-audio-capture--real-time-mixing)
   - [4.2 Voice Activity Detection (VAD) & Live Transcription](#42-voice-activity-detection-vad--live-transcription)
   - [4.3 Meeting Stopping & SQLite Persistence](#43-meeting-stopping--sqlite-persistence)
   - [4.4 AI Summarization & Intelligence Pipeline](#44-ai-summarization--intelligence-pipeline)
   - [4.5 Crash Recovery & Audio Checkpointing](#45-crash-recovery--audio-checkpointing)
5. [Feature-by-Feature Deep Dive](#5-feature-by-feature-deep-dive)
6. [Database Schema & Data Models](#6-database-schema--data-models)
   - [6.1 Database Engine & File Paths](#61-database-engine--file-paths)
   - [6.2 Complete Entity-Relationship Diagram (ERD)](#62-complete-entity-relationship-diagram-erd)
   - [6.3 Detailed Table DDL Specifications](#63-detailed-table-ddl-specifications)
   - [6.4 Schema Migrations History](#64-schema-migrations-history)
7. [Tauri IPC Reference (Commands & Events)](#7-tauri-ipc-reference-commands--events)
8. [Developer & Modification Guide](#8-developer--modification-guide)

---

## 1. System Overview & Tech Stack

Meetily is designed to ensure **complete data sovereignty**. No meeting recordings, transcripts, or summaries ever leave the user's computer unless the user explicitly configures an external cloud LLM provider.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      Meetily Desktop Application                         │
│                                                                          │
│  ┌────────────────────────┐                   ┌───────────────────────┐  │
│  │   Next.js 14 Frontend  │   Tauri 2.x IPC   │   Rust Core Backend   │  │
│  │   (React 18 / Tailwind)│ ◄───────────────► │   (CPAL / Whisper-rs) │  │
│  └────────────────────────┘  Commands/Events  └───────────┬───────────┘  │
│                                                           │              │
│                                      ┌────────────────────┼───────────┐  │
│                                      ▼                    ▼           ▼  │
│                            ┌───────────────────┐ ┌───────────────┐ ┌──┴─┐│
│                            │   llama-helper    │ │ Embedded DB   │ │OS  ││
│                            │ (llama-cpp sidecar│ │ (SQLite/sqlx) │ │Aud ││
│                            └───────────────────┘ └───────────────┘ └───┬┘│
└─────────────────────────────────────────────────────────────────────────┼┘
                                                                          │
                                     Microphone & System Audio Loopback ◄─┘
```

### Core Technologies

| Layer | Technology | Purpose |
| :--- | :--- | :--- |
| **Desktop Shell** | **Tauri 2.x** | Ultra-lightweight native window manager, system tray, notifications, OS permissions, and IPC bridge. |
| **Frontend Framework** | **Next.js 14 + React 18** | Client-rendered UI, routing, hooks, and responsive Tailwind CSS layout. |
| **Rich Text Editor** | **BlockNote (ProseMirror)** | Notion-style block editor for meeting notes and editable AI summaries. |
| **Audio Capture** | **CPAL + WASAPI / SCKit** | Cross-platform audio capture (WASAPI loopback on Windows, ScreenCaptureKit on macOS). |
| **Audio Processing** | **Rubato, nnnoiseless, ebur128**| Resampling, neural noise suppression, RMS ducking, clipping prevention. |
| **Voice Activity Detection**| **Silero VAD (silero_rs)** | Filters silence/background noise so only true speech is passed to STT. |
| **Speech-to-Text (STT)** | **Whisper.cpp (`whisper-rs`)**<br>**Parakeet ONNX (`ort`)** | Local transcription. Supports Metal (macOS), CUDA (NVIDIA), Vulkan (AMD/Intel), or CPU. |
| **AI Summarization** | **llama-cpp-2 (`llama-helper`)**<br>**Ollama / Cloud APIs** | Local GGUF models (Llama 3.2, Qwen 2.5) running isolated in a sidecar, or cloud providers (Claude, OpenAI, Groq, OpenRouter). |
| **Persistence** | **SQLite + SQLx (WAL mode)** | Embedded database storing meetings, transcripts, settings, and summaries. |
| **Client Storage** | **IndexedDB** | Real-time transcript buffering and crash recovery storage in the browser layer. |

> [!IMPORTANT]
> **Archived Backend Notice**: The `backend/` folder in the root of the repository contains an obsolete Python/FastAPI tier from earlier versions. It is kept solely as an archive and is **not** used by the desktop app. All backend operations run in the native Rust core (`frontend/src-tauri`).

---

## 2. Repository & Directory Structure

```
meetily/
├── frontend/                     # Main desktop application project
│   ├── src/                      # Next.js React frontend
│   │   ├── app/                  # Next.js App Router pages
│   │   │   ├── layout.tsx        # Root layout, providers, onboarding check, drag-and-drop
│   │   │   ├── page.tsx          # Main dashboard & live recording interface
│   │   │   ├── meeting-details/  # Meeting viewer, audio sync playback, AI summary tab
│   │   │   ├── settings/         # Configuration (Recording, Models, API keys, Beta)
│   │   │   └── notes/            # Standalone rich-text notes viewer
│   │   ├── components/           # Reusable UI components
│   │   │   ├── RecordingControls # Start, pause, resume, stop buttons & timer
│   │   │   ├── AudioLevelMeter   # Live input volume visualization
│   │   │   ├── AudioPlayer       # Audio scrubber synchronized with transcript timestamps
│   │   │   ├── BlockNoteEditor   # Notion-like block editor for meeting notes & summaries
│   │   │   ├── WhisperModelManager # Download and select Whisper.cpp models
│   │   │   ├── ParakeetModelManager# Download and select Parakeet ONNX models
│   │   │   └── Sidebar/          # Meeting history list, search bar, navigation
│   │   ├── contexts/             # Global React state contexts
│   │   │   ├── RecordingStateContext # Live recording state machine
│   │   │   ├── TranscriptContext     # Real-time transcript segments & meeting title
│   │   │   ├── ConfigContext         # Application settings & active model selection
│   │   │   └── OnboardingContext     # First-launch model setup wizard
│   │   ├── hooks/                # Custom React hooks (audio, recording, summary, recovery)
│   │   └── services/             # Client adapters for Tauri IPC & IndexedDB
│   │
│   └── src-tauri/                # Tauri Rust Core Backend
│       ├── Cargo.toml            # Rust dependencies & hardware acceleration features
│       ├── tauri.conf.json       # Tauri window configuration, bundle info, permissions
│       ├── migrations/           # SQLx database schema migrations
│       ├── templates/            # JSON prompt templates for meeting summaries
│       └── src/
│           ├── lib.rs            # Application bootstrap, setup hook, command registry
│           ├── audio/            # Audio capture, device discovery, mixing, VAD, saving
│           ├── whisper_engine/   # Whisper.cpp integration, model loader, parallel STT
│           ├── parakeet_engine/  # ONNX Runtime Parakeet transcription engine
│           ├── summary/          # Summary engine, prompt builders, language detection
│           ├── database/         # SQLite database manager & SQLx repositories
│           ├── api/              # API bridge connecting frontend to database repositories
│           ├── notifications/    # Native OS notifications with Do-Not-Disturb detection
│           ├── tray.rs           # System tray icon, minimize behavior, quick controls
│           └── onboarding.rs     # Onboarding status tracking
│
├── llama-helper/                 # Standalone Rust sidecar for local LLM inference
│   ├── Cargo.toml                # llama-cpp-2 dependencies
│   └── src/main.rs               # Stdin/stdout JSON protocol server for GGUF models
│
└── docs/                         # Documentation assets, screenshots, build guides
```

---

## 3. Architecture & Module Attachment

### How Frontend and Backend Connect

The frontend and backend interact via **Tauri IPC** through two distinct communication patterns:

```mermaid
flowchart LR
    subgraph Frontend ["Next.js (TypeScript)"]
        FCmd["invoke('command_name', { args })"]
        FEvt["listen('event-name', (payload) => { ... })"]
    end

    subgraph IPC ["Tauri 2.x IPC Bridge"]
    end

    subgraph Backend ["Rust Core (lib.rs)"]
        RCmd["#[tauri::command]\nasync fn command_name() -> Result<T, String>"]
        REvt["app.emit('event-name', payload)"]
    end

    FCmd -->|Request| IPC -->|Dispatches to| RCmd
    RCmd -.->|Response (JSON)| IPC -.->|Promise resolves| FCmd
    REvt -->|Broadcast| IPC -->|Calls callback| FEvt
```

1. **Commands (Frontend Request → Rust Response)**:
   - Example: Starting a recording, fetching meetings from SQLite, triggering a summary.
   - Frontend: `await invoke('start_recording', { mic_device_name, system_device_name, meeting_name })`
   - Rust: Handled by `#[tauri::command]` functions in `audio/recording_commands.rs`, registered in `lib.rs`.
2. **Events (Rust Push → Frontend Callback)**:
   - Example: Streaming new transcript segments, live audio levels, download progress, crash warnings.
   - Rust: `app.emit("transcript-update", &segment)`
   - Frontend: `await listen<TranscriptUpdate>('transcript-update', (e) => { ... })`

---

## 4. End-to-End Data Flows

### 4.1 Audio Capture & Real-Time Mixing

When a recording starts:
1. **Device Discovery**: The app queries available input devices (microphones) and output devices (system audio loopback) via `audio/devices/discovery.rs` (using WASAPI loopback on Windows, ScreenCaptureKit on macOS).
2. **Asynchronous Stream Ingestion**: Microphone and system audio streams arrive on separate threads at varying sample rates.
3. **Ring Buffer Mixing**: `AudioMixerRingBuffer` in `audio/pipeline.rs` synchronizes the two streams into unified 50ms time windows at 48kHz.
4. **Professional RMS Ducking**: `ProfessionalAudioMixer` applies root-mean-square ducking so that loud system audio automatically dips when the user speaks into the microphone, preventing clipping and speech masking.

```mermaid
flowchart TD
    Mic[Microphone Stream] --> RingBuf[AudioMixerRingBuffer\n(50ms Window Synchronization)]
    Sys[System Audio Loopback] --> RingBuf
    RingBuf --> Ducking[ProfessionalAudioMixer\n(RMS Ducking & Clipping Protection)]
    Ducking --> Split{Dual Pipeline}
    Split -->|Continuous Audio| Saver[RecordingSaver\n(Incremental WAV Checkpoints)]
    Split -->|Processed Audio| VAD[Voice Activity Detection\n(Silero VAD / nnnoiseless)]
    VAD -->|Speech Chunks| STT[Transcription Engine\n(Whisper / Parakeet)]
```

---

### 4.2 Voice Activity Detection (VAD) & Live Transcription

1. **Silence Trimming**: The mixed 48kHz audio is downsampled to 16kHz mono and evaluated by **Silero VAD**. Non-speech segments are discarded, reducing AI inference compute by approximately 70%.
2. **Chunking**: When speech is detected, the audio buffer is packed into a chunk and passed to the active STT engine (`whisper_engine` or `parakeet_engine`).
3. **Inference**: The model performs speech recognition with timestamp alignment (`audio_start_time` and `audio_end_time`).
4. **Streaming Updates**: Rust emits `transcript-update` over Tauri IPC.
5. **State & Cache**: The frontend receives the event, appends the segment to React state (`TranscriptContext`), and saves a copy in `IndexedDB` to ensure resilience against crashes.

---

### 4.3 Meeting Stopping & SQLite Persistence

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as React UI
    participant Rust as Tauri Rust Core
    participant Pipeline as Audio Pipeline
    participant STT as Whisper Engine
    participant DB as SQLite (sqlx)

    User->>UI: Clicks "Stop Recording"
    UI->>Rust: invoke('stop_recording', { save_path })
    Rust->>Pipeline: Stop capture streams
    Rust->>Pipeline: Drain remaining audio in ring buffer
    Pipeline->>STT: Final audio chunks
    STT-->>Rust: Final transcript segments
    Rust->>DB: INSERT INTO meetings (id, title, folder_path, created_at)
    Rust->>DB: INSERT INTO transcripts (meeting_id, transcript, audio_start_time, audio_end_time)
    Rust->>UI: emit('recording-stopped') & emit('recording-stop-complete')
    UI->>UI: Navigate to `/meeting-details?id=...&source=recording`
```

---

### 4.4 AI Summarization & Intelligence Pipeline

Meeting summaries can be generated automatically on meeting end or manually from the Meeting Details page:

```mermaid
flowchart TD
    Start[User Clicks 'Generate Summary'] --> Cmd[api_process_transcript]
    Cmd --> DBInit[Mark summary_processes as 'processing']
    Cmd --> Svc[SummaryService::process_transcript_background]
    
    subgraph Background Processing
        Svc --> Lang[Language Detection\n(Whatlang: auto-detects language)]
        Svc --> Tmpl[Template Loader\n(daily_standup.json, standard_meeting.json)]
        Svc --> Chunker[Transcript Chunker\n(handles large meeting context limits)]
        Chunker --> Router{Provider Router}
        
        Router -->|Built-in Local AI| LlamaHelper[llama-helper sidecar\n(Local GGUF via stdin/stdout)]
        Router -->|Local Ollama| Ollama[Local Ollama API\nhttp://localhost:11434]
        Router -->|Cloud APIs| Cloud[OpenAI / Anthropic / Groq / OpenRouter]
        
        LlamaHelper --> Result[JSON / Markdown Output]
        Ollama --> Result
        Cloud --> Result
        Result --> DBSave[UPDATE summary_processes\nstatus='completed', result=JSON]
    end

    DBSave -.-> Poll[Frontend Polling\napi_get_summary]
    Poll --> Render[Render in BlockNote Editor]
```

#### Supported AI Providers

1. **Built-in Local AI**: Runs models like Llama 3.2 or Qwen 2.5 directly on the user's hardware via `llama-helper` without any external installs.
2. **Local Ollama**: Connects to an existing local Ollama instance (`http://localhost:11434`).
3. **Cloud Providers**: Supports OpenAI (`gpt-4o`, `gpt-4o-mini`), Anthropic Claude (`claude-3-5-sonnet`), Groq (`llama-3.3-70b`), and OpenRouter with user-supplied API keys stored securely in SQLite.
4. **Custom OpenAI-Compatible**: Allows connecting to self-hosted vLLM, LM Studio, or local enterprise inference gateways.

---

### 4.5 Crash Recovery & Audio Checkpointing

To prevent data loss if the computer crashes or power fails:
- **Audio Checkpoints**: `incremental_saver.rs` flushes audio to disk every few seconds into timestamped checkpoint files.
- **Client Backup**: `indexedDBService.ts` buffers transcript segments in browser IndexedDB in real time.
- **Startup Detection**: When Meetily boots, `app/page.tsx` checks if any unfinalized meetings exist. If found, a recovery dialog allows the user to restore the meeting, finalize the audio file, and save all recovered transcripts.

---

## 5. Feature-by-Feature Deep Dive

### 1. Dual Audio Capture & Loopback
- **Microphone**: Direct capture from selected input hardware via CPAL.
- **System Audio**: Native loopback driver capture. On Windows, uses WASAPI loopback; on macOS, uses ScreenCaptureKit (or BlackHole); on Linux, uses ALSA/PulseAudio.
- **Volume Metering**: Live audio levels emitted via `audio-levels` event to animate the visualizer bars in `AudioLevelMeter.tsx`.

### 2. Whisper & Parakeet Model Manager
- Whisper models (`tiny`, `base`, `small`, `medium`, `large-v3`) can be downloaded directly from HuggingFace within the app settings.
- Real-time download progress events (`model-download-progress`, `model-download-complete`) are shown with native progress toasts.
- Supports switching between Whisper.cpp and Parakeet ONNX engines based on hardware capability.

### 3. Synchronized Audio & Transcript Playback
- Each transcript row records its exact `audio_start_time` and `audio_end_time` relative to the audio file.
- The `AudioPlayer` component enables clicking any transcript paragraph to immediately seek audio playback to that specific moment.

### 4. Audio File Import & Retranscription
- Users can drag and drop external audio files (`.mp3`, `.wav`, `.m4a`, `.aac`, `.flac`) onto the app window.
- Audio is decoded using `symphonia` or `ffmpeg-sidecar`, chunked, and transcribed into a new meeting.
- Existing meetings can also be re-transcribed with different models or languages using the "Retranscribe" dialog.

### 5. Notion-Style Meeting Notes & Summaries
- Integrated **BlockNote Editor** provides markdown-compatible rich text editing.
- AI summaries format automatically into collapsible headings, bulleted lists, action item checkboxes, and key decisions.
- Users can edit AI-generated summaries and save modifications directly to the database.

### 6. System Tray & Background Operation
- Closing the main window hides it to the system tray rather than killing ongoing recordings.
- The tray menu reflects live recording status and provides quick "Start Recording", "Stop Recording", and "Open Window" commands.

---

## 6. Database Schema & Data Models

Meetily is backed by **Supabase PostgreSQL** in the cloud, accessed natively from the Tauri Rust backend via **Rust SQLx (`sqlx::PgPool`)** with connection pooling and automated schema initialization.

### 6.1 Database Engine & Cloud Connection

- **Engine**: Supabase Managed PostgreSQL
- **Connection**: Direct PostgreSQL URI (`postgresql://postgres:***@db.[PROJECT-REF].supabase.co:5432/postgres`)
- **Connection Pooling**: Managed via `sqlx::postgres::PgPoolOptions` with 10 max connections and automated connection timeouts.
- **Environment Configuration**: Set via `DATABASE_URL` or `SUPABASE_DB_URL` environment variables, or defaults to the configured connection in `config.rs`.
- **Automatic Initialization**: On startup, `database/manager.rs` verifies and creates all required tables, constraints, and indexes in Supabase automatically.

### 6.2 Complete Entity-Relationship Diagram (ERD)

```mermaid
erDiagram
    meetings ||--o{ transcripts : "has many (CASCADE)"
    meetings ||--o| summary_processes : "has one (CASCADE)"
    meetings ||--o{ transcript_chunks : "has many (CASCADE)"
    meetings ||--o| meeting_notes : "has one (CASCADE)"

    meetings {
        TEXT id PK "Unique Meeting ID"
        TEXT title "Meeting Title"
        TEXT created_at "ISO-8601 UTC timestamp"
        TEXT updated_at "ISO-8601 UTC timestamp"
        TEXT folder_path "Disk folder path containing audio.wav"
    }

    transcripts {
        TEXT id PK "Unique Segment UUID"
        TEXT meeting_id FK "References meetings(id)"
        TEXT transcript "Recognized text segment"
        TEXT timestamp "Wall-clock time string (e.g. 14:30:15)"
        TEXT summary "Optional per-segment summary"
        TEXT action_items "Optional extracted action items"
        TEXT key_points "Optional key points"
        REAL audio_start_time "Seconds from start (seek offset)"
        REAL audio_end_time "Seconds from start"
        REAL duration "Segment duration in seconds"
        TEXT speaker "Source: 'mic' or 'system' or speaker label"
    }

    summary_processes {
        TEXT meeting_id PK,FK "References meetings(id)"
        TEXT status "idle | processing | completed | failed | cancelled"
        TEXT created_at "ISO-8601 timestamp"
        TEXT updated_at "ISO-8601 timestamp"
        TEXT error "Error message if failed"
        TEXT result "JSON string containing final structured summary"
        TEXT start_time "ISO-8601 generation start"
        TEXT end_time "ISO-8601 generation finish"
        INTEGER chunk_count "Transcript chunks processed"
        REAL processing_time "Time taken in seconds"
        TEXT metadata "JSON string with provider & model info"
        TEXT result_backup "Backup of previous summary"
        TEXT result_backup_timestamp "Timestamp of backup"
    }

    transcript_chunks {
        TEXT meeting_id PK,FK "References meetings(id)"
        TEXT meeting_name "Meeting title snapshot"
        TEXT transcript_text "Combined text formatted for LLM"
        TEXT model "Model family (e.g. ollama, openai)"
        TEXT model_name "Specific model (e.g. llama-3.2, gpt-4o)"
        INTEGER chunk_size "Token/character chunk size"
        INTEGER overlap "Overlap between chunks"
        TEXT created_at "ISO-8601 timestamp"
    }

    meeting_notes {
        TEXT meeting_id PK,FK "References meetings(id)"
        TEXT notes_markdown "Raw markdown of notes"
        TEXT notes_json "BlockNote JSON block structure"
        TEXT created_at "ISO-8601 timestamp"
        TEXT updated_at "ISO-8601 timestamp"
    }

    settings {
        TEXT id PK "'default'"
        TEXT provider "Summary provider (ollama, openai, groq, etc.)"
        TEXT model "Active summary model name"
        TEXT whisperModel "Default Whisper model"
        TEXT groqApiKey "Groq API key"
        TEXT openaiApiKey "OpenAI API key"
        TEXT anthropicApiKey "Claude API key"
        TEXT ollamaApiKey "Ollama auth key"
        TEXT openRouterApiKey "OpenRouter API key"
        TEXT geminiApiKey "Google Gemini API key"
        TEXT ollamaEndpoint "Custom Ollama URL"
        TEXT customOpenAIConfig "JSON: {endpoint, apiKey, model, ...}"
    }

    transcript_settings {
        TEXT id PK "'default'"
        TEXT provider "STT provider: localWhisper | parakeet | deepgram"
        TEXT model "STT model name (e.g. large-v3, nova-2)"
        TEXT whisperApiKey "Cloud Whisper key"
        TEXT deepgramApiKey "Deepgram API key"
        TEXT elevenLabsApiKey "ElevenLabs key"
        TEXT groqApiKey "Groq STT key"
        TEXT openaiApiKey "OpenAI STT key"
    }

    licensing {
        TEXT license_key PK "Decrypted license key"
        TEXT encrypted_key "RSA encrypted payload"
        TEXT signature_hash "SHA-256 integrity hash"
        TEXT activation_date "ISO-8601 timestamp"
        TEXT expiry_date "ISO-8601 timestamp"
        TEXT soft_expiry_date "Grace expiry date"
        INTEGER duration "Duration in seconds"
        INTEGER grace_period "Grace period in seconds (default 604800 = 7d)"
        INTEGER is_soft_expired "0=active, 1=grace period, 2=blocked"
    }
```

### 6.3 Detailed Table DDL Specifications

#### 1. `meetings`
Primary root table representing each recording or imported meeting session.
```sql
CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,               -- e.g. 'meeting-550e8400-e29b-41d4-a716-446655440000'
    title TEXT NOT NULL,               -- e.g. 'Engineering Sync'
    created_at TEXT NOT NULL,          -- ISO-8601 UTC timestamp
    updated_at TEXT NOT NULL,          -- ISO-8601 UTC timestamp
    folder_path TEXT                   -- Absolute path to meeting directory with audio.wav
);
```

#### 2. `transcripts`
Stores granular speech segments. Precise `audio_start_time` and `audio_end_time` values allow clicking any transcript line in the UI to jump the `AudioPlayer` to that exact second.
```sql
CREATE TABLE IF NOT EXISTS transcripts (
    id TEXT PRIMARY KEY,               -- Unique segment UUID
    meeting_id TEXT NOT NULL,          -- Foreign key to meetings(id)
    transcript TEXT NOT NULL,          -- The recognized spoken text
    timestamp TEXT NOT NULL,           -- Wall-clock time (e.g. "14:30:15")
    summary TEXT,                      -- Optional per-segment summary
    action_items TEXT,                 -- Optional extracted action items
    key_points TEXT,                   -- Optional key points
    audio_start_time REAL,             -- Seconds from audio start (e.g. 125.3)
    audio_end_time REAL,               -- Seconds from audio start (e.g. 128.6)
    duration REAL,                     -- Segment duration in seconds (e.g. 3.3)
    speaker TEXT,                      -- 'mic' (microphone), 'system' (computer audio), or speaker label
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);
```

#### 3. `summary_processes`
Manages the state machine and persistence for AI meeting summaries.
```sql
CREATE TABLE IF NOT EXISTS summary_processes (
    meeting_id TEXT PRIMARY KEY,       -- Foreign key to meetings(id)
    status TEXT NOT NULL,              -- 'idle' | 'processing' | 'completed' | 'failed' | 'cancelled'
    created_at TEXT NOT NULL,          -- ISO-8601 timestamp
    updated_at TEXT NOT NULL,          -- ISO-8601 timestamp
    error TEXT,                        -- Error message if failed
    result TEXT,                       -- JSON string containing structured markdown & BlockNote blocks
    start_time TEXT,                   -- Generation start timestamp
    end_time TEXT,                     -- Generation completion timestamp
    chunk_count INTEGER DEFAULT 0,     -- Number of chunks processed
    processing_time REAL DEFAULT 0.0,  -- Total processing time in seconds
    metadata TEXT,                     -- JSON metadata (model, provider, parameters)
    result_backup TEXT,                -- Preserves previous summary if user regenerates and cancels
    result_backup_timestamp TEXT,      -- Timestamp when backup was taken
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);
```

#### 4. `transcript_chunks`
Stores pre-chunked transcript text formatted with overlap for passing to large language models.
```sql
CREATE TABLE IF NOT EXISTS transcript_chunks (
    meeting_id TEXT PRIMARY KEY,
    meeting_name TEXT,
    transcript_text TEXT NOT NULL,      -- Full combined text
    model TEXT NOT NULL,               -- Provider (e.g. 'ollama', 'openai')
    model_name TEXT NOT NULL,          -- Specific model (e.g. 'llama-3.2', 'gpt-4o')
    chunk_size INTEGER,                -- Context chunk size (default: 40000)
    overlap INTEGER,                   -- Overlap between chunks (default: 1000)
    created_at TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);
```

#### 5. `meeting_notes`
Stores user-written notes from the integrated BlockNote rich-text editor.
```sql
CREATE TABLE IF NOT EXISTS meeting_notes (
    meeting_id TEXT PRIMARY KEY NOT NULL,
    notes_markdown TEXT,               -- Plain markdown text
    notes_json TEXT,                   -- ProseMirror / BlockNote block structure JSON
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_meeting_notes_meeting_id ON meeting_notes(meeting_id);
```

#### 6. `settings`
Stores LLM summary configuration and credentials (single row with `id = 'default'`).
```sql
CREATE TABLE IF NOT EXISTS settings (
    id TEXT PRIMARY KEY,               -- Always 'default'
    provider TEXT NOT NULL,            -- 'ollama' | 'openai' | 'anthropic' | 'groq' | 'openrouter'
    model TEXT NOT NULL,               -- Active summary model
    whisperModel TEXT NOT NULL,        -- Default local Whisper model
    groqApiKey TEXT,                   -- Groq API key
    openaiApiKey TEXT,                 -- OpenAI API key
    anthropicApiKey TEXT,              -- Anthropic Claude API key
    ollamaApiKey TEXT,                 -- Optional Ollama auth key
    openRouterApiKey TEXT,             -- OpenRouter API key
    geminiApiKey TEXT,                 -- Google Gemini API key
    ollamaEndpoint TEXT,               -- e.g. "http://localhost:11434"
    customOpenAIConfig TEXT            -- JSON: { endpoint, apiKey, model, maxTokens, temperature }
);
```

#### 7. `transcript_settings`
Stores Speech-to-Text (STT) transcription engine preferences and API keys. **This is where Deepgram's API key is stored.**
```sql
CREATE TABLE IF NOT EXISTS transcript_settings (
    id TEXT PRIMARY KEY,               -- Always 'default'
    provider TEXT NOT NULL,            -- 'localWhisper' | 'parakeet' | 'deepgram' | 'groq' | 'openai'
    model TEXT NOT NULL,               -- Model identifier (e.g. 'large-v3', 'nova-2')
    whisperApiKey TEXT,                -- Cloud Whisper key
    deepgramApiKey TEXT,               -- <--- DEEPGRAM API KEY PERSISTENCE
    elevenLabsApiKey TEXT,             -- ElevenLabs key
    groqApiKey TEXT,                   -- Groq STT key
    openaiApiKey TEXT                  -- OpenAI Whisper key
);
```

#### 8. `licensing`
Handles cryptographic RSA verification for offline license key validation and grace periods.
```sql
CREATE TABLE IF NOT EXISTS licensing (
    license_key TEXT PRIMARY KEY,      -- Decrypted license ID
    encrypted_key TEXT NOT NULL,       -- Original encrypted key (RSA + Base64)
    signature_hash TEXT NOT NULL,      -- SHA-256 hash for integrity validation
    activation_date TEXT NOT NULL,     -- Activation ISO-8601 timestamp
    expiry_date TEXT NOT NULL,         -- Expiry ISO-8601 timestamp
    soft_expiry_date TEXT NOT NULL,    -- Expiry + grace period timestamp
    max_activation_time TEXT NOT NULL, -- Machine activation count from license payload
    duration INTEGER NOT NULL,         -- Duration in seconds
    generated_on TEXT NOT NULL,        -- Generation ISO-8601 timestamp
    is_soft_expired INTEGER DEFAULT 0, -- 0 = active, 1 = grace period, 2 = blocked
    grace_period INTEGER NOT NULL DEFAULT 604800 -- Grace period in seconds (7 days)
);
```

### 6.4 Schema Migrations History

All schema changes are tracked sequentially in `frontend/src-tauri/migrations/`:

| Version | Migration File | Description |
| :--- | :--- | :--- |
| `20250916100000` | `initial_schema.sql` | Base schema: `meetings`, `transcripts`, `summary_processes`, `transcript_chunks`, `settings`, `transcript_settings` (including `deepgramApiKey`). |
| `20250920155811` | `add_openrouter_api_key.sql` | Adds `openRouterApiKey` to `settings`. |
| `20251006000000` | `add_audio_sync_fields.sql` | Adds `folder_path` to `meetings`; adds `audio_start_time`, `audio_end_time`, `duration` to `transcripts`. |
| `20251010153942` | `add_ollama_endpoint.sql` | Adds `ollamaEndpoint` to `settings`. |
| `20251101000000` | `add_summary_backup.sql` | Adds `result_backup` and `result_backup_timestamp` to `summary_processes` for safe regeneration. |
| `20251105120000` | `add_pro_license_custom_openai.sql` | Adds `customOpenAIConfig` to `settings`; creates `licensing` table. |
| `20251110000000` | `add_grace_period_to_licensing.sql` | Adds `grace_period` (default 7 days) to `licensing`. |
| `20251110000001` | `add_speaker_field.sql` | Adds `speaker` column to `transcripts` (`mic`, `system`, or speaker ID). |
| `20251223000000` | `add_meeting_notes.sql` | Creates `meeting_notes` table and index for Notion-like notes. |
| `20251229000000` | `add_gemini_api_key.sql` | Adds `geminiApiKey` to `settings`. |

---

## 7. Tauri IPC Reference (Commands & Events)

### Core Tauri Commands

| Command Name | Module | Description |
| :--- | :--- | :--- |
| `start_recording` | `audio::recording_commands` | Starts mic and system audio capture and audio pipeline. |
| `stop_recording` | `audio::recording_commands` | Flushes buffers, stops capture, and saves WAV file. |
| `is_recording` | `audio::recording_commands` | Returns boolean indicating if recording is currently active. |
| `pause_recording` / `resume_recording` | `audio::recording_commands` | Pauses/resumes incoming audio stream ingestion. |
| `get_audio_devices` | `audio::devices` | Lists all available system input and output devices. |
| `start_audio_level_monitoring` | `audio::simple_level_monitor` | Starts emitting live volume levels for VU meters. |
| `whisper_load_model` | `whisper_engine::commands` | Loads a Whisper GGML model into memory/GPU. |
| `whisper_download_model` | `whisper_engine::commands` | Downloads a model from HuggingFace with progress events. |
| `parakeet_load_model` | `parakeet_engine::commands` | Loads an ONNX Parakeet model. |
| `api_get_meetings` | `api` | Fetches list of all meetings from SQLite. |
| `api_get_meeting` | `api` | Fetches details and metadata of a specific meeting. |
| `api_get_meeting_transcripts`| `api` | Fetches all transcript segments for a meeting. |
| `api_delete_meeting` | `api` | Deletes meeting record, transcripts, and summary. |
| `api_save_meeting_title` | `api` | Updates meeting title. |
| `api_process_transcript` | `summary::commands` | Spawns background AI summary generation task. |
| `api_get_summary` | `summary::commands` | Retrieves current status and output of a summary process. |
| `api_cancel_summary` | `summary::commands` | Cancels an ongoing summary generation job. |
| `api_get_model_config` | `api` | Gets current LLM provider and model configuration. |
| `api_save_model_config` | `api` | Saves LLM provider, model, and API credentials. |

### Core Tauri Events

| Event Name | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `transcript-update` | Rust → UI | `TranscriptUpdate` | Emitted when a new speech segment is transcribed. |
| `speech-detected` | Rust → UI | `{}` | Emitted whenever VAD detects active voice activity. |
| `audio-levels` | Rust → UI | `AudioLevelUpdate` | Emits volume levels (0.0 to 1.0) for live VU meters. |
| `recording-stopped` | Rust → UI | `RecordingStoppedPayload` | Emitted when audio capture has stopped. |
| `recording-stop-complete` | Rust → UI | `bool` | Emitted when all trailing transcriptions are saved. |
| `model-download-progress` | Rust → UI | `{ modelName, progress }` | Model download percentage (0 to 100). |
| `model-download-complete` | Rust → UI | `{ modelName }` | Model download successfully finished. |
| `transcription-error` | Rust → UI | `{ error, userMessage }` | Emitted on audio device or model errors. |

---

## 8. Developer & Modification Guide

### Development Prerequisites

- **Node.js**: 18.x or 20.x
- **pnpm**: `npm install -g pnpm`
- **Rust**: 1.77+ (`rustup default stable`)
- **C++ Build Tools**:
  - **Windows**: Visual Studio Build Tools with C++ workload.
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`).
  - **Linux**: `cmake`, `llvm`, `libomp-dev`, `alsa` development headers.

### Running Locally

```bash
# 1. Navigate to frontend
cd frontend

# 2. Install dependencies
pnpm install

# 3. Run Tauri desktop app in development mode
pnpm run tauri:dev
```

### Hardware-Accelerated Builds

| Target | Command | Notes |
| :--- | :--- | :--- |
| **macOS (Apple Silicon)** | `pnpm run tauri:dev:metal` | Metal & CoreML are auto-enabled on macOS. |
| **Windows (NVIDIA)** | `pnpm run tauri:dev:cuda` | Requires CUDA Toolkit installed. |
| **Windows/Linux (AMD/Intel)** | `pnpm run tauri:dev:vulkan` | Requires Vulkan SDK / drivers. |
| **CPU Only (Generic)** | `pnpm run tauri:dev:cpu` | Uses OpenBLAS fallback without GPU requirements. |

### Common Modification Workflows

#### A. Adding a New Tauri Command
1. Create your async function in the target Rust module (e.g. `frontend/src-tauri/src/api/`):
   ```rust
   #[tauri::command]
   pub async fn my_custom_command(param: String) -> Result<String, String> {
       Ok(format!("Processed: {}", param))
   }
   ```
2. Register the command in `frontend/src-tauri/src/lib.rs` inside the `tauri::generate_handler![...]` macro.
3. Invoke it from TypeScript:
   ```typescript
   import { invoke } from '@tauri-apps/api/core';
   const result = await invoke<string>('my_custom_command', { param: 'test' });
   ```

#### B. Modifying Summary Prompts & Output Formats
- Edit or add JSON prompt templates under `frontend/src-tauri/templates/` (e.g. `daily_standup.json`, `standard_meeting.json`).
- Template parsing and chunk injection logic lives in `frontend/src-tauri/src/summary/templates/` and `frontend/src-tauri/src/summary/service.rs`.

#### C. Modifying the UI / Adding a New Page
- Next.js uses the App Router under `frontend/src/app/`.
- Add a new directory (e.g., `frontend/src/app/analytics/page.tsx`) to create a new page.
- Add navigation items in `frontend/src/components/Sidebar/index.tsx`.

# CrestMeet

**CrestMeet** is an intelligent, privacy-conscious desktop meeting assistant designed to streamline meeting capture, real-time transcription, and automated AI summary generation. Built with a modern desktop architecture using **Tauri v2**, **Rust**, and **Next.js**, CrestMeet delivers native performance, low resource consumption, and end-to-end data control.

---

## Key Features

- **Dual-Channel Audio Capture**: Seamlessly records system audio (remote meeting participants) and microphone audio (local user) simultaneously using low-latency native audio APIs.
- **Real-Time & Batch Transcription**: 
  - Local speech-to-text powered by Whisper models with on-device GPU/CPU acceleration.
  - Cloud speech-to-text integration with Deepgram for fast and accurate live transcription.
- **AI-Powered Meeting Summarization**:
  - Automatically extracts key discussion points, decisions, and structured action items.
  - Multi-provider support: Run fully offline via **Ollama**, or connect with **Groq**, **OpenAI**, or **Anthropic Claude**.
  - Customizable summary templates (Daily Standups, Standard Meetings, Client Discussions).
- **Multi-Tenant Cloud Sync**:
  - Secure user authentication and session management.
  - Isolated multi-tenant storage powered by **Supabase PostgreSQL**.
- **Modern Desktop Experience**:
  - Fast, responsive interface built with Next.js 14, React, and TailwindCSS.
  - Native cross-platform desktop integration via Tauri v2.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    CrestMeet Desktop UI                    │
│                 (Next.js 14 / React / Tailwind)             │
└──────────────────────────────┬──────────────────────────────┘
                               │ Tauri IPC
┌──────────────────────────────▼──────────────────────────────┐
│                    Rust Application Core                    │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────┐ │
│  │ Audio Subsystem  │ │ Speech-to-Text   │ │ AI Summary   │ │
│  │ (CPAL / Loopback)│ │ (Whisper/Deepgram│ │ (Groq/Ollama)│ │
│  └──────────────────┘ └──────────────────┘ └──────────────┘ │
└──────────────────────────────┬──────────────────────────────┘
                               │ SQLx Pool
┌──────────────────────────────▼──────────────────────────────┐
│                     Supabase PostgreSQL                     │
│        (Meetings, Transcripts, Summaries, User Auth)        │
└─────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Desktop Shell** | [Tauri v2](https://tauri.app/) (Rust) |
| **Frontend Framework** | [Next.js 14](https://nextjs.org/) & [React](https://react.dev/) |
| **Styling & Components** | TailwindCSS, Radix UI |
| **Audio Capture** | CPAL (Cross-Platform Audio Library), WASAPI Loopback |
| **Transcription Engines** | Local Whisper / Deepgram Live STT |
| **LLM Inference** | Groq, Ollama (Local), OpenAI, Anthropic |
| **Database & Auth** | Supabase (PostgreSQL, Transaction Pooler, Row-Level / Multi-Tenant Isolation) |

---

## Getting Started

### Prerequisites

Ensure you have the following installed on your development machine:

- **Node.js**: `v18` or later (LTS recommended)
- **Package Manager**: `pnpm` (`v8` or later)
- **Rust**: Latest stable Rust toolchain via [rustup](https://rustup.rs/)
- **C++ Build Tools**:
  - **Windows**: Visual Studio Build Tools with the *"Desktop development with C++"* workload
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: Build essentials, OpenSSL, and WebKit2GTK dependencies

### Installation

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd meetily
   ```

2. **Install frontend dependencies**:
   ```bash
   cd frontend
   pnpm install
   ```

3. **Run the desktop application in development mode**:
   ```bash
   pnpm run tauri:dev
   ```

4. **Build for production**:
   ```bash
   pnpm run tauri:build
   ```

---

## Configuration

Application settings (such as LLM providers, transcription models, and API keys) can be configured directly inside the application's **Settings** panel:

- **Speech-to-Text**: Choose between local Whisper models or cloud STT (Deepgram).
- **AI Summary Provider**: Select from Groq (recommended for ultra-fast summaries), local Ollama, OpenAI, or Claude.
- **Database**: Cloud configuration is managed through Supabase database connection settings.

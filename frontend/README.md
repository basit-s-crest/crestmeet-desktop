# CrestMeet - Frontend & Desktop App

Frontend application and Tauri desktop layer for **CrestMeet**. Built with **Next.js 14** and **Tauri v2** for a responsive, native desktop experience.

---

## Architecture Overview

```
frontend/
├── src/               # Next.js frontend application (React, TailwindCSS, Radix UI)
│   ├── app/           # App router pages (dashboard, meetings, settings)
│   ├── components/    # Reusable UI components
│   ├── contexts/      # State providers (Auth, Audio, Config)
│   └── hooks/         # Custom React hooks
├── src-tauri/         # Rust native desktop layer
│   ├── src/           # Rust source code (audio capture, DB, summaries)
│   └── Cargo.toml     # Rust dependencies & configuration
├── public/            # Static assets
└── package.json       # Frontend dependencies & scripts
```

---

## Development Setup

### Prerequisites

- **Node.js**: `v18` or higher
- **pnpm**: `v8` or higher (`npm install -g pnpm`)
- **Rust**: Latest stable toolchain (`rustup`)
- **Platform C++ Build Tools**:
  - **Windows**: Visual Studio Build Tools with C++ workload
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: Standard build essentials and WebKit2GTK libraries

### Installation

```bash
pnpm install
```

### Running Locally

Run both the Next.js frontend and the Tauri desktop window:

```bash
pnpm run tauri:dev
```

To run only the web interface in the browser (for UI tweaking):

```bash
pnpm run dev
```

### Production Build

Create an optimized desktop installer (MSI / NSIS on Windows, DMG on macOS, AppImage / DEB on Linux):

```bash
pnpm run tauri:build
```

---

## Audio & Transcription Pipeline

- **Audio Capture**: Managed by the Rust layer via `cpal`, capturing both microphone and system audio (WASAPI loopback on Windows).
- **Transcription**: Supports local Whisper models as well as cloud-based real-time transcription via Deepgram.
- **AI Summaries**: Processed asynchronously in Rust and streamed/polled by the frontend interface.

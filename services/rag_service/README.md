# CrestMeet RAG Service

Local Python service for high-performance chunking, context enrichment, and local embedding inference for CrestMeet.

## Features
- **Speaker-Turn Window Chunker:** Chunking transcripts into 250–350 token windows with 1-turn overlap without splitting mid-sentence.
- **Context Enrichment:** Generates context headers `{Project | Meeting | Date | Speakers}` and context notes before embedding.
- **Lightweight ONNX Embeddings:** Uses `fastembed` with pinned `bge-small-en-v1.5` (384-dimensional vectors) without heavy PyTorch overhead.
- **FastAPI Loopback Server:** Clean HTTP endpoints for integration with the Tauri (Rust) desktop backend.

## Environment Management with `uv`

Ensure you have [uv](https://docs.astral.sh/uv/) installed:
```bash
# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

### 1. Install Dependencies
```bash
cd services/rag_service
uv sync
```

### 2. Run the Service Locally
```bash
uv run python -m crestmeet_rag.api
```
The service will start on `http://127.0.0.1:8765`.

### 3. Run Tests
```bash
uv run pytest
```

"""Entrypoint script to run the CrestMeet Model Verification & RAG API server."""

import os
import sys

# Ensure UTF-8 output on Windows consoles
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Ensure src is on sys.path
src_dir = os.path.join(os.path.dirname(__file__), "src")
if src_dir not in sys.path:
    sys.path.insert(0, src_dir)

import uvicorn

if __name__ == "__main__":
    print("=" * 70)
    print("Starting CrestMeet OCR & Pyannote Model Verification Backend")
    print("OpenAPI / Swagger UI: http://127.0.0.1:8123/docs")
    print("ReDoc Documentation:  http://127.0.0.1:8123/redoc")
    print("=" * 70)
    uvicorn.run("crestmeet_rag.api:app", host="127.0.0.1", port=8123, reload=False)

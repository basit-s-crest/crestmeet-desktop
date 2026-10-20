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

import logging
import uvicorn

# Setup file logging: in %APPDATA%\Meetily\logs\python_pipeline.log, erased on each new startup
appdata = os.getenv("APPDATA")
if appdata:
    log_dir = os.path.join(appdata, "Meetily", "logs")
else:
    log_dir = os.path.join(os.path.expanduser("~"), ".meetily", "logs")

os.makedirs(log_dir, exist_ok=True)
log_file = os.path.join(log_dir, "python_pipeline.log")

file_handler = logging.FileHandler(log_file, mode="w", encoding="utf-8")
file_handler.setFormatter(
    logging.Formatter("[%(asctime)s] [%(levelname)s] [%(name)s]: %(message)s")
)

stream_handler = logging.StreamHandler(sys.stdout)
stream_handler.setFormatter(
    logging.Formatter("[%(asctime)s] [%(levelname)s] [%(name)s]: %(message)s")
)

logging.basicConfig(
    level=logging.INFO,
    handlers=[file_handler, stream_handler],
)

if __name__ == "__main__":
    print("=" * 70)
    print("Starting CrestMeet OCR & Pyannote Model Verification Backend")
    print(f"Log file location: {log_file}")
    print("OpenAPI / Swagger UI: http://127.0.0.1:8123/docs")
    print("ReDoc Documentation:  http://127.0.0.1:8123/redoc")
    print("=" * 70)

    # Configure uvicorn loggers to also output to our single file handler with overwrite mode
    log_config = uvicorn.config.LOGGING_CONFIG
    log_config["handlers"]["file"] = {
        "class": "logging.FileHandler",
        "filename": log_file,
        "mode": "w",
        "encoding": "utf-8",
        "formatter": "default",
    }
    if "handlers" in log_config["loggers"]["uvicorn"]:
        log_config["loggers"]["uvicorn"]["handlers"].append("file")
    if "handlers" in log_config["loggers"]["uvicorn.access"]:
        log_config["loggers"]["uvicorn.access"]["handlers"].append("file")

    uvicorn.run("crestmeet_rag.api:app", host="127.0.0.1", port=8123, reload=False, log_config=log_config)

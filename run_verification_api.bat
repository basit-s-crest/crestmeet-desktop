@echo off
title CrestMeet OCR & Pyannote OpenAPI Verification Backend
echo ======================================================================
echo Starting CrestMeet OCR & Pyannote Verification API Server...
echo ======================================================================
echo.
cd /d "%~dp0services\rag_service"
call .venv\Scripts\python.exe run_server.py
pause

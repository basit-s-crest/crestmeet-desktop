"""FastAPI Router for Pyannote 3.1 ONNX Diarization."""

import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from crestmeet_rag.pyannote_3_0.engine import pyannote3_engine
from crestmeet_rag.pyannote_3_0.schemas import DiarizationResponse

logger = logging.getLogger("crestmeet_rag.pyannote_3_0")

router = APIRouter(prefix="/api", tags=["Pyannote 3.1 ONNX Diarization"])


class DiarizePathRequest(BaseModel):
    """File-path based diarization request for local meeting recordings."""
    file_path: str = Field(..., description="Absolute path to WAV or MP3 audio file")
    num_speakers: Optional[int] = Field(None, description="Exact speaker count if known (leave blank for automatic detection)")
    include_rttm: bool = Field(False, description="Whether to include raw NIST RTTM string")


class DiarizePathResponse(DiarizationResponse):
    """Diarization response with optional RTTM text output."""
    rttm: Optional[str] = None


@router.get("/diarize/info")
def get_diarization_info():
    """Get metadata about the Pyannote 3.1 ONNX Extended segmentation and embedding models."""
    return {
        "engine": "pyannote/speaker-diarization-3.1 (ONNX Extended)",
        "segmentation_model": "onnx-community/pyannote-segmentation-3.0",
        "embedding_model": pyannote3_engine.emb_model_name,
        "sample_rate_hz": 16000,
        "status": (
            "ready"
            if (
                pyannote3_engine.segmentation_session is not None
                and pyannote3_engine.embedding_session is not None
            )
            else "model_missing"
        ),
        "source": "https://github.com/samson6460/pyannote-onnx-extended",
        "default_mode": True,
    }


@router.post("/diarize", response_model=DiarizationResponse)
async def diarize_audio_file(
    file: UploadFile = File(..., description="Meeting audio recording (WAV/MP3)"),
    num_speakers: Optional[int] = None,
):
    """Run Pyannote 3.1 Extended ONNX diarization on an uploaded audio file."""
    try:
        contents = await file.read()
        audio, sr = pyannote3_engine.load_audio(contents)
        clean_num = num_speakers if (num_speakers is not None and num_speakers > 0) else None

        resp = await run_in_threadpool(
            pyannote3_engine.diarize_audio,
            audio,
            sr,
            num_speakers=clean_num,
        )
        return resp
    except Exception as e:
        logger.error(f"Pyannote 3.1 diarization failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Diarization failed: {str(e)}")


@router.post("/diarize-path", response_model=DiarizePathResponse)
async def diarize_audio_path(request: DiarizePathRequest):
    """Run Pyannote 3.1 Extended ONNX diarization on a local audio file path."""
    p = Path(request.file_path)
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail=f"Audio file not found: {request.file_path}")

    try:
        audio, sr = pyannote3_engine.load_audio_from_file(p)
        clean_num = request.num_speakers if (request.num_speakers is not None and request.num_speakers > 0) else None

        resp = await run_in_threadpool(
            pyannote3_engine.diarize_audio,
            audio,
            sr,
            num_speakers=clean_num,
        )

        rttm_str = pyannote3_engine.to_rttm(resp, uri=p.stem) if request.include_rttm else None

        return DiarizePathResponse(
            total_duration_seconds=resp.total_duration_seconds,
            speaker_clusters=resp.speaker_clusters,
            diarized_turns=resp.diarized_turns,
            processing_time_ms=resp.processing_time_ms,
            rttm=rttm_str,
        )
    except Exception as e:
        logger.error(f"Pyannote 3.1 path diarization failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Path diarization failed: {str(e)}")


@router.post("/diarize/rttm", response_class=PlainTextResponse)
async def diarize_to_rttm(
    file: UploadFile = File(..., description="Meeting audio recording (WAV/MP3)"),
    num_speakers: Optional[int] = Form(None),
):
    """Run Pyannote 3.1 Extended ONNX and return standard NIST RTTM text output."""
    try:
        contents = await file.read()
        audio, sr = pyannote3_engine.load_audio(contents)
        clean_num = num_speakers if (num_speakers is not None and num_speakers > 0) else None

        resp = await run_in_threadpool(
            pyannote3_engine.diarize_audio,
            audio,
            sr,
            num_speakers=clean_num,
        )
        return PlainTextResponse(pyannote3_engine.to_rttm(resp, uri=Path(file.filename or "audio").stem))
    except Exception as e:
        logger.error(f"RTTM generation failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"RTTM failed: {str(e)}")

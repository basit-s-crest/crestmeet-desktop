"""FastAPI router for Pyannote diarization and speaker verification testing."""

from fastapi import APIRouter, File, HTTPException, UploadFile
from crestmeet_rag.pyannote.engine import PyannoteEngine
from crestmeet_rag.pyannote.schemas import (
    DiarizationResponse,
    PyannoteModelInfo,
    SegmentationResponse,
    SpeakerEmbeddingResponse,
    SpeakerVerificationRequest,
    SpeakerVerificationResponse,
)

router = APIRouter(prefix="/api/pyannote", tags=["Pyannote Diarization & Speaker Verification"])
pyannote_engine = PyannoteEngine()


@router.get("/info", response_model=PyannoteModelInfo)
def get_pyannote_model_info():
    """Get metadata on the configured Pyannote segmentation and WeSpeaker embedding models."""
    return pyannote_engine.model_info


@router.post("/segment-audio", response_model=SegmentationResponse)
async def segment_audio(
    file: UploadFile = File(..., description="Audio file (WAV, MP3, FLAC, OGG) to segment into speech regions"),
):
    """
    Run Pyannote segmentation-3.0 / VAD on an uploaded audio file.
    Detects continuous speech regions, speech boundaries, and speech ratio.
    """
    try:
        contents = await file.read()
        audio_data, sr = pyannote_engine.load_audio_from_bytes(contents)
        return pyannote_engine.segment_audio(audio_data, sr)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Audio segmentation failed: {str(e)}")


@router.post("/extract-embedding", response_model=SpeakerEmbeddingResponse)
async def extract_speaker_embedding(
    file: UploadFile = File(..., description="Audio speech sample from a single speaker (WAV/MP3)"),
):
    """
    Extract a normalized 512-dimensional speaker embedding vector
    using the WeSpeaker / Pyannote VoxCeleb ResNet-34 architecture.
    """
    try:
        contents = await file.read()
        audio_data, sr = pyannote_engine.load_audio_from_bytes(contents)
        return pyannote_engine.extract_embedding(audio_data, sr)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Embedding extraction failed: {str(e)}")


@router.post("/verify-audio-pair", response_model=SpeakerVerificationResponse)
async def verify_audio_pair(
    speaker_a_audio: UploadFile = File(..., description="Voice sample from Speaker A (WAV/MP3)"),
    speaker_b_audio: UploadFile = File(..., description="Voice sample from Speaker B (WAV/MP3)"),
):
    """
    Verify if two audio recordings belong to the same speaker.
    Extracts 512-dim embeddings for each clip, computes cosine similarity,
    and returns a match verdict based on the voice profile threshold (0.72).
    """
    try:
        bytes_a = await speaker_a_audio.read()
        bytes_b = await speaker_b_audio.read()

        audio_a, sr_a = pyannote_engine.load_audio_from_bytes(bytes_a)
        audio_b, sr_b = pyannote_engine.load_audio_from_bytes(bytes_b)

        embed_a = pyannote_engine.extract_embedding(audio_a, sr_a)
        embed_b = pyannote_engine.extract_embedding(audio_b, sr_b)

        return pyannote_engine.verify_speakers(
            embed_a.embedding,
            embed_b.embedding,
            threshold=pyannote_engine.model_info.speaker_verification_threshold,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Speaker verification failed: {str(e)}")


@router.post("/verify-embeddings", response_model=SpeakerVerificationResponse)
def verify_embedding_vectors(request: SpeakerVerificationRequest):
    """
    Test direct cosine similarity comparison between two 512-dimensional speaker vectors.
    """
    if len(request.embedding_a) != 512 or len(request.embedding_b) != 512:
        raise HTTPException(
            status_code=400,
            detail=f"Both embeddings must be 512 dimensions. Got {len(request.embedding_a)} and {len(request.embedding_b)}",
        )
    return pyannote_engine.verify_speakers(
        request.embedding_a,
        request.embedding_b,
        threshold=request.threshold,
    )


@router.post("/diarize", response_model=DiarizationResponse)
async def diarize_meeting_audio(
    file: UploadFile = File(..., description="Multi-speaker meeting audio recording (WAV/MP3)"),
):
    """
    Run offline speaker diarization on a meeting recording.
    Segments audio and clusters speech into mic:S0 and system speakers (sys:S1, sys:S2).
    """
    try:
        contents = await file.read()
        audio_data, sr = pyannote_engine.load_audio_from_bytes(contents)
        return pyannote_engine.diarize_audio(audio_data, sr)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Diarization failed: {str(e)}")

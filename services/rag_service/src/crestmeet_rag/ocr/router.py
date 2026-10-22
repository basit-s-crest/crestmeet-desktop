"""FastAPI router for OCR testing and attendee verification."""

from typing import List, Optional
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from PIL import Image
import io

from crestmeet_rag.ocr.engine import ScreenOcrEngine, APP_ROI_PRESETS
from crestmeet_rag.ocr.schemas import (
    AppPreset,
    FuzzyMatchRequest,
    FuzzyMatchResponse,
    OcrRecognizeRequest,
    OcrRecognizeResponse,
    VotingSimulationRequest,
    VotingSimulationResponse,
)
from crestmeet_rag.ocr.voting import fuzzy_match_attendees, solve_voting

router = APIRouter(prefix="/api/ocr", tags=["OCR & Screen Speaker Recognition"])
ocr_engine = ScreenOcrEngine()


@router.get("/status")
def get_ocr_status():
    """Check OCR engine capability, RapidOCR, and Windows.Media.Ocr status."""
    is_rapid = ocr_engine.is_rapid_ocr_available
    is_native = ocr_engine.is_native_windows_ocr_available
    lang = None
    if is_native and ocr_engine.winrt_engine:
        try:
            lang = ocr_engine.winrt_engine.recognizer_language.display_name
        except Exception:
            lang = "Windows OCR Active"

    return {
        "status": "online",
        "engine": ocr_engine.engine_name,
        "rapid_ocr_available": is_rapid,
        "native_windows_media_ocr": is_native,
        "recognizer_language": lang,
        "active_speaker_border_detection": True,
        "supported_app_presets": [p.value for p in AppPreset],
    }


@router.post("/recognize-base64", response_model=OcrRecognizeResponse)
def recognize_ocr_base64(request: OcrRecognizeRequest):
    """
    Test OCR on a base64 encoded meeting frame or screenshot.
    Applies app layout crop (Teams, Zoom, Google Meet), runs OCR,
    cleans tokens, and matches against attendee list.
    """
    try:
        return ocr_engine.process_request(request)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OCR processing failed: {str(e)}")


@router.post("/recognize-upload", response_model=OcrRecognizeResponse)
async def recognize_ocr_upload(
    file: UploadFile = File(..., description="Upload meeting screenshot or participant tile image (PNG/JPEG)"),
    app_preset: AppPreset = Form(AppPreset.GENERIC, description="Meeting app layout preset"),
    attendees: Optional[str] = Form(
        None, description="Comma-separated list of calendar attendees (e.g., 'Sarah Connor, John Doe, Alex Rivera')"
    ),
):
    """
    Test OCR by directly uploading an image file from Swagger UI.
    Detects active speaker colored highlight border, extracts all participant
    names in the grid, and fuzzy-matches against calendar attendees.
    """
    try:
        contents = await file.read()
        image = Image.open(io.BytesIO(contents)).convert("RGB")

        attendee_list = []
        if attendees:
            attendee_list = [a.strip() for a in attendees.split(",") if a.strip()]

        return ocr_engine.process_pil_image(
            image=image,
            app_preset=app_preset,
            attendee_names=attendee_list,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process uploaded image: {str(e)}")


@router.post("/fuzzy-match", response_model=FuzzyMatchResponse)
def test_fuzzy_match(request: FuzzyMatchRequest):
    """
    Test candidate name fuzzy matching against calendar attendees.
    Cleans raw OCR tokens, calculates similarity scores, and determines commit vs suggestion.
    """
    cleaned = ocr_engine.clean_name(request.raw_ocr_text)
    best_match, score, all_scores = fuzzy_match_attendees(
        cleaned, request.attendee_names, min_similarity=0.0
    )

    is_commit = score >= request.commit_threshold
    is_suggested = score >= request.suggestion_threshold and not is_commit

    return FuzzyMatchResponse(
        raw_text=request.raw_ocr_text,
        cleaned_text=cleaned,
        best_match=best_match if score >= request.suggestion_threshold else None,
        similarity_score=score,
        is_auto_commit=is_commit,
        is_suggested=is_suggested,
        suggestion_chip=best_match if (is_commit or is_suggested) else None,
        all_scores=all_scores,
    )


@router.post("/simulate-voting", response_model=VotingSimulationResponse)
def simulate_voting(request: VotingSimulationRequest):
    """
    Test the multi-observation 1-to-1 Hungarian voting solver.
    Feed multiple OCR observations across clusters to verify auto-commit,
    margin thresholds, and prevent duplicate name assignments.
    """
    return solve_voting(
        observations=request.observations,
        unresolved_clusters=request.unresolved_clusters,
        auto_commit_threshold=request.auto_commit_threshold,
        suggestion_threshold=request.suggestion_threshold,
        margin_threshold=request.margin_threshold,
    )


@router.post("/resolve-meeting-speakers", response_model=ResolveMeetingSpeakersResponse)
def api_resolve_meeting_speakers(request: ResolveMeetingSpeakersRequest):
    """
    End-to-end meeting speaker name resolution combining:
    - Screen/video frame active speaker tile detection & RapidOCR on label crops
    - Pinned/spotlight tile neutralization via neighbor frame consistency
    - Transcript conversational cues (self-introduction, handoff address, thank-you acknowledgment)
    - Bayesian probability scoring and 1-to-1 conflict resolution
    - Generation of the complete Meeting Dossier audit JSON
    """
    try:
        from crestmeet_rag.ocr.resolver import resolve_meeting_speakers
        return resolve_meeting_speakers(request, ocr_engine)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to resolve meeting speakers: {str(e)}")


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
    """Check OCR engine capability and Windows.Media.Ocr status."""
    is_native = ocr_engine.is_native_windows_ocr_available
    lang = None
    if is_native and ocr_engine.winrt_engine:
        try:
            lang = ocr_engine.winrt_engine.recognizer_language.display_name
        except Exception:
            lang = "Windows OCR Active"

    return {
        "status": "online",
        "engine": "Windows.Media.Ocr (Native WinRT)" if is_native else "Fallback Pattern Engine",
        "native_windows_media_ocr": is_native,
        "recognizer_language": lang,
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
    Extracts text, strips role tokens, and matches with calendar attendees.
    """
    try:
        contents = await file.read()
        image = Image.open(io.BytesIO(contents)).convert("RGB")

        # Determine ROI and crop
        roi = APP_ROI_PRESETS.get(app_preset, APP_ROI_PRESETS[AppPreset.GENERIC])
        cropped = ocr_engine.crop_roi(image, roi)

        raw_text, lines, ocr_conf = ocr_engine.run_ocr_on_pil_image(cropped)
        if not raw_text.strip():
            raw_text, lines, ocr_conf = ocr_engine.run_ocr_on_pil_image(image)

        cleaned_name = ocr_engine.clean_name(raw_text)

        attendee_list = []
        if attendees:
            attendee_list = [a.strip() for a in attendees.split(",") if a.strip()]

        matched_attendee = None
        similarity_score = 0.0
        if attendee_list and cleaned_name:
            matched_attendee, similarity_score, _ = fuzzy_match_attendees(
                cleaned_name, attendee_list, min_similarity=0.55
            )

        combined_score = round(ocr_conf * (similarity_score if matched_attendee else 0.8), 4)

        return OcrRecognizeResponse(
            app_preset=app_preset.value,
            raw_full_text=raw_text,
            detected_lines=lines,
            cleaned_name=cleaned_name,
            matched_attendee=matched_attendee,
            similarity_score=similarity_score,
            ocr_confidence=round(ocr_conf, 4),
            combined_score=combined_score,
            should_auto_commit=combined_score >= 0.70 and matched_attendee is not None,
            suggested_chip=matched_attendee or (cleaned_name if len(cleaned_name) >= 3 else None),
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

"""OCR Engine using Windows Media OCR with meeting app layout adapters."""

import base64
import io
import re
from typing import List, Optional, Tuple
from PIL import Image

from crestmeet_rag.ocr.schemas import (
    AppPreset,
    NormalizedRoi,
    OcrRecognizeRequest,
    OcrRecognizeResponse,
    OcrTextLine,
)
from crestmeet_rag.ocr.voting import fuzzy_match_attendees

# Try to import native Windows.Media.Ocr via WinRT
_HAS_WINRT_OCR = False
try:
    import winrt.windows.media.ocr as win_ocr
    import winrt.windows.graphics.imaging as win_imaging
    import winrt.windows.storage.streams as win_streams
    _HAS_WINRT_OCR = True
except Exception:
    _HAS_WINRT_OCR = False


# Default meeting app ROI presets
APP_ROI_PRESETS = {
    AppPreset.TEAMS: NormalizedRoi(x=0.02, y=0.85, width=0.35, height=0.12),
    AppPreset.ZOOM: NormalizedRoi(x=0.01, y=0.88, width=0.30, height=0.10),
    AppPreset.GOOGLE_MEET: NormalizedRoi(x=0.02, y=0.86, width=0.32, height=0.10),
    AppPreset.GENERIC: NormalizedRoi(x=0.02, y=0.80, width=0.45, height=0.18),
    AppPreset.CUSTOM: NormalizedRoi(x=0.0, y=0.0, width=1.0, height=1.0),
}

DEFAULT_STRIP_TOKENS = [
    "(You)",
    "(you)",
    "(Guest)",
    "(guest)",
    "(External)",
    "(external)",
    "(Host)",
    "(host)",
    "(Co-host)",
    "(Me)",
    "Presenting",
    "presenting",
    "Muted",
    "muted",
    "Talking:",
    "talking:",
    "Presentation",
    "pin",
]


class ScreenOcrEngine:
    """Screen OCR processor for meeting participant name extraction."""

    def __init__(self):
        self.winrt_engine = None
        if _HAS_WINRT_OCR:
            try:
                self.winrt_engine = win_ocr.OcrEngine.try_create_from_user_profile_languages()
            except Exception:
                self.winrt_engine = None

    @property
    def is_native_windows_ocr_available(self) -> bool:
        return self.winrt_engine is not None

    def crop_roi(self, image: Image.Image, roi: NormalizedRoi) -> Image.Image:
        """Crop image based on normalized 0.0-1.0 coordinates."""
        width, height = image.size
        left = int(roi.x * width)
        top = int(roi.y * height)
        right = min(int((roi.x + roi.width) * width), width)
        bottom = min(int((roi.y + roi.height) * height), height)

        if right <= left or bottom <= top:
            return image
        return image.crop((left, top, right, bottom))

    def clean_name(self, raw_text: str, extra_strip_tokens: Optional[List[str]] = None) -> str:
        """Clean raw OCR text by stripping known app indicators and special characters."""
        text = raw_text.strip()
        tokens = list(DEFAULT_STRIP_TOKENS)
        if extra_strip_tokens:
            tokens.extend(extra_strip_tokens)

        for token in tokens:
            text = text.replace(token, "")

        # Take first line if multiline badge
        first_line = text.splitlines()[0] if text.splitlines() else ""
        first_line = re.sub(r"[^\w\s\-\.\']", "", first_line)
        first_line = re.sub(r"\s+", " ", first_line).strip()
        return first_line

    def run_ocr_on_pil_image(self, image: Image.Image) -> Tuple[str, List[OcrTextLine], float]:
        """Run Windows.Media.Ocr on a PIL Image."""
        if not self.winrt_engine:
            # Fallback when running outside Windows OCR capability
            return "", [], 0.0

        buf = io.BytesIO()
        image.save(buf, format="PNG")
        png_bytes = buf.getvalue()

        writer = win_streams.DataWriter()
        writer.write_bytes(png_bytes)
        buf_stream = writer.detach_buffer()

        mem_stream = win_streams.InMemoryRandomAccessStream()
        mem_stream.write_async(buf_stream).get()
        mem_stream.seek(0)

        decoder = win_imaging.BitmapDecoder.create_async(mem_stream).get()
        software_bitmap = decoder.get_software_bitmap_async().get()

        ocr_result = self.winrt_engine.recognize_async(software_bitmap).get()
        full_text = ocr_result.text or ""

        lines = []
        for line in ocr_result.lines:
            lines.append(
                OcrTextLine(
                    text=line.text,
                    confidence=0.92,
                )
            )

        avg_confidence = 0.90 if lines else 0.0
        return full_text, lines, avg_confidence

    def process_request(self, request: OcrRecognizeRequest) -> OcrRecognizeResponse:
        """Full pipeline: decode image -> crop ROI -> run OCR -> clean text -> fuzzy match."""
        # 1. Decode base64 image
        raw_b64 = request.image_base64
        if "," in raw_b64:
            raw_b64 = raw_b64.split(",", 1)[1]

        image_data = base64.b64decode(raw_b64)
        image = Image.open(io.BytesIO(image_data)).convert("RGB")

        # 2. Determine ROI
        roi = request.custom_roi or APP_ROI_PRESETS.get(request.app_preset, APP_ROI_PRESETS[AppPreset.GENERIC])
        cropped = self.crop_roi(image, roi)

        # 3. Run OCR
        raw_text, detected_lines, ocr_conf = self.run_ocr_on_pil_image(cropped)

        # If native OCR did not detect lines or was empty on cropped, try full image
        if not raw_text.strip() and roi.width < 0.95:
            full_raw, full_lines, full_conf = self.run_ocr_on_pil_image(image)
            if full_raw.strip():
                raw_text = full_raw
                detected_lines = full_lines
                ocr_conf = full_conf

        # 4. Clean participant name
        cleaned_name = self.clean_name(raw_text, request.extra_strip_tokens)

        # 5. Attendee fuzzy matching
        matched_attendee = None
        similarity_score = 0.0
        if request.attendee_names and cleaned_name:
            matched_attendee, similarity_score, _ = fuzzy_match_attendees(
                cleaned_name, request.attendee_names, min_similarity=0.55
            )

        # Combined quality score: ocr_conf * similarity (or ocr_conf if no attendee list)
        combined_score = round(ocr_conf * (similarity_score if matched_attendee else 0.8), 4)
        should_commit = combined_score >= 0.70 and matched_attendee is not None
        suggested_chip = matched_attendee or (cleaned_name if len(cleaned_name) >= 3 else None)

        return OcrRecognizeResponse(
            app_preset=request.app_preset.value,
            raw_full_text=raw_text,
            detected_lines=detected_lines,
            cleaned_name=cleaned_name,
            matched_attendee=matched_attendee,
            similarity_score=similarity_score,
            ocr_confidence=round(ocr_conf, 4),
            combined_score=combined_score,
            should_auto_commit=should_commit,
            suggested_chip=suggested_chip,
        )

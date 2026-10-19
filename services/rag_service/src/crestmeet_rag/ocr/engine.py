"""OCR Engine supporting RapidOCR (deep-learning ONNX) and Windows Media OCR fallback.
Includes active speaker highlight border detection (Zoom green/yellow, Teams purple, Meet blue)
and multi-tile grid participant name extraction.
"""

import base64
import io
import re
from typing import List, Optional, Tuple
import cv2
import numpy as np
from PIL import Image

from crestmeet_rag.ocr.schemas import (
    AppPreset,
    NormalizedRoi,
    OcrRecognizeRequest,
    OcrRecognizeResponse,
    OcrTextLine,
)
from crestmeet_rag.ocr.voting import fuzzy_match_attendees

# Try to import RapidOCR (high accuracy deep-learning ONNX model)
_HAS_RAPID_OCR = False
try:
    from rapidocr_onnxruntime import RapidOCR
    _HAS_RAPID_OCR = True
except Exception:
    _HAS_RAPID_OCR = False

# Try to import native Windows.Media.Ocr via WinRT
_HAS_WINRT_OCR = False
try:
    import winrt.windows.media.ocr as win_ocr
    import winrt.windows.graphics.imaging as win_imaging
    import winrt.windows.storage.streams as win_streams
    _HAS_WINRT_OCR = True
except Exception:
    _HAS_WINRT_OCR = False


# Default single-speaker ROI presets (used when no active speaker border is found)
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
    "Unmute",
    "Stop Video",
    "Share Screen",
    "Participants",
    "Breakout Rooms",
    "Reactions",
    "End Meeting",
    "Speaker View",
    "Exit Full Screen",
]


class ScreenOcrEngine:
    """Screen OCR processor for meeting participant name extraction and active speaker detection."""

    def __init__(self):
        self.rapid_ocr = None
        if _HAS_RAPID_OCR:
            try:
                self.rapid_ocr = RapidOCR()
            except Exception:
                self.rapid_ocr = None

        self.winrt_engine = None
        if _HAS_WINRT_OCR:
            try:
                self.winrt_engine = win_ocr.OcrEngine.try_create_from_user_profile_languages()
            except Exception:
                self.winrt_engine = None

    @property
    def is_rapid_ocr_available(self) -> bool:
        return self.rapid_ocr is not None

    @property
    def is_native_windows_ocr_available(self) -> bool:
        return self.winrt_engine is not None

    @property
    def engine_name(self) -> str:
        if self.is_rapid_ocr_available:
            return "RapidOCR (Deep-Learning ONNX)"
        if self.is_native_windows_ocr_available:
            return "Windows.Media.Ocr (Native WinRT)"
        return "Fallback Pattern Engine"

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

    def detect_active_speaker_tile(self, bgr_image: np.ndarray) -> Optional[Tuple[int, int, int, int]]:
        """Detect the bounding box (x, y, w, h) of an active speaker tile by looking for

        the characteristic colored highlight outline (Zoom green/yellow, Teams purple, Meet blue).
        """
        try:
            hsv = cv2.cvtColor(bgr_image, cv2.COLOR_BGR2HSV)
            H, W = bgr_image.shape[:2]
            min_area = (W * 0.08) * (H * 0.08)
            max_area = (W * H * 0.95)

            # 1. Zoom Green / Yellow-Green outline: HSV Hue 22-90, Sat 40-255, Val 55-255
            mask_zoom = cv2.inRange(hsv, np.array([22, 40, 55]), np.array([90, 255, 255]))

            # 2. Teams Purple/Violet outline: HSV Hue 125-165, Sat 40-255, Val 55-255
            mask_teams = cv2.inRange(hsv, np.array([125, 40, 55]), np.array([165, 255, 255]))

            # 3. Google Meet Blue outline: HSV Hue 95-125, Sat 60-255, Val 60-255
            mask_meet = cv2.inRange(hsv, np.array([95, 60, 60]), np.array([125, 255, 255]))

            combined = cv2.bitwise_or(mask_zoom, mask_teams)
            combined = cv2.bitwise_or(combined, mask_meet)

            # Morphological close to connect border outline lines
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
            closed = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, kernel)

            contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            best_rect = None
            max_detected_area = 0

            for cnt in contours:
                x, y, w, h = cv2.boundingRect(cnt)
                area = w * h
                if min_area < area < max_area:
                    aspect = w / float(h)
                    # Video tiles typically have aspect ratio between 0.75 and 2.6
                    if 0.75 <= aspect <= 2.6:
                        if area > max_detected_area:
                            max_detected_area = area
                            best_rect = (x, y, w, h)

            return best_rect
        except Exception:
            return None

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
        first_line = re.sub(r"[^\w\s\-\.\'\(\)]", "", first_line)
        first_line = re.sub(r"\s+", " ", first_line).strip()
        return first_line

    def run_rapid_ocr(
        self, image: Image.Image
    ) -> Tuple[str, List[OcrTextLine], float, List[Tuple[list, str, float]]]:
        """Run RapidOCR on PIL Image."""
        if not self.rapid_ocr:
            return "", [], 0.0, []

        np_img = np.array(image)
        # Convert RGB to BGR for OpenCV
        if len(np_img.shape) == 3 and np_img.shape[2] == 3:
            bgr = cv2.cvtColor(np_img, cv2.COLOR_RGB2BGR)
        else:
            bgr = np_img

        result, _ = self.rapid_ocr(bgr)
        if not result:
            return "", [], 0.0, []

        lines = []
        raw_items = []
        full_text_parts = []
        total_conf = 0.0

        for item in result:
            bbox, text, conf = item
            clean_t = text.strip()
            if not clean_t:
                continue

            full_text_parts.append(clean_t)
            total_conf += conf
            lines.append(
                OcrTextLine(
                    text=clean_t,
                    confidence=round(float(conf), 3),
                    bounding_box={"points": bbox},
                )
            )
            raw_items.append((bbox, clean_t, float(conf)))

        avg_conf = (total_conf / len(lines)) if lines else 0.0
        return "\n".join(full_text_parts), lines, round(avg_conf, 3), raw_items

    def run_winrt_ocr(self, image: Image.Image) -> Tuple[str, List[OcrTextLine], float]:
        """Run Windows.Media.Ocr fallback on a PIL Image."""
        if not self.winrt_engine:
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

    def run_ocr_on_pil_image(self, image: Image.Image) -> Tuple[str, List[OcrTextLine], float]:
        """Unified OCR runner prioritizing RapidOCR with WinRT fallback."""
        if self.rapid_ocr:
            text, lines, conf, _ = self.run_rapid_ocr(image)
            if lines:
                return text, lines, conf

        return self.run_winrt_ocr(image)

    def process_pil_image(
        self,
        image: Image.Image,
        app_preset: AppPreset = AppPreset.GENERIC,
        custom_roi: Optional[NormalizedRoi] = None,
        attendee_names: Optional[List[str]] = None,
        extra_strip_tokens: Optional[List[str]] = None,
    ) -> OcrRecognizeResponse:
        """Full pipeline:

        1. Active speaker highlight contour detection (Zoom green/yellow, Teams purple)
        2. High-accuracy OCR (RapidOCR) on full frame
        3. Match text to active speaker tile or custom/preset ROI
        4. Extract all participant names across the grid
        5. Fuzzy match against calendar attendees
        """
        attendee_names = attendee_names or []
        img_np = np.array(image)
        bgr = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR) if img_np.ndim == 3 else img_np

        # 1. Detect active speaker tile border
        active_tile_rect = self.detect_active_speaker_tile(bgr)

        # 2. Run OCR (RapidOCR gets all text with exact 2D bounding boxes)
        raw_text, detected_lines, ocr_conf, raw_boxes = self.run_rapid_ocr(image)

        # Fallback to WinRT if RapidOCR returned nothing
        if not detected_lines:
            # If custom ROI or preset requested
            roi = custom_roi or APP_ROI_PRESETS.get(app_preset, APP_ROI_PRESETS[AppPreset.GENERIC])
            cropped = self.crop_roi(image, roi) if roi.width < 0.95 else image
            raw_text, detected_lines, ocr_conf = self.run_winrt_ocr(cropped)
            if not raw_text.strip() and roi.width < 0.95:
                raw_text, detected_lines, ocr_conf = self.run_winrt_ocr(image)

        # 3. Extract and clean all distinct participant names detected across the grid
        all_grid_names = []
        for line in detected_lines:
            cleaned = self.clean_name(line.text, extra_strip_tokens)
            # Filter out UI words and single chars
            if len(cleaned) >= 3 and not any(
                w.lower() in cleaned.lower()
                for w in ["unmute", "video", "share screen", "participants", "record", "reactions", "end"]
            ):
                if cleaned not in all_grid_names:
                    all_grid_names.append(cleaned)

        # 4. Resolve Active Speaker Name
        active_speaker_name = None
        active_speaker_detected = False

        if active_tile_rect and raw_boxes:
            ax, ay, aw, ah = active_tile_rect
            # Find candidate text line that falls within this active speaker tile
            tile_candidates = []
            for bbox, text, conf in raw_boxes:
                # Top-left and bottom-right of text bounding box
                xs = [pt[0] for pt in bbox]
                ys = [pt[1] for pt in bbox]
                tx_min, tx_max = min(xs), max(xs)
                ty_min, ty_max = min(ys), max(ys)

                # Check if text box overlaps with active speaker tile (especially lower half)
                if ax - 10 <= tx_min and tx_max <= ax + aw + 10:
                    if ay - 10 <= ty_min and ty_max <= ay + ah + 15:
                        c_name = self.clean_name(text, extra_strip_tokens)
                        if len(c_name) >= 3:
                            # Higher priority for text in lower third of the tile (name tag position)
                            in_lower_half = ty_min >= (ay + ah * 0.45)
                            tile_candidates.append((in_lower_half, conf, c_name))

            if tile_candidates:
                # Sort: lower half first, then highest confidence
                tile_candidates.sort(key=lambda c: (c[0], c[1]), reverse=True)
                active_speaker_name = tile_candidates[0][2]
                active_speaker_detected = True

        # If active speaker tile was not detected, determine primary name:
        if active_speaker_name:
            primary_name = active_speaker_name
        elif custom_roi:
            # If custom ROI was provided, find text in that ROI
            W, H = image.size
            roi_x, roi_y = custom_roi.x * W, custom_roi.y * H
            roi_w, roi_h = custom_roi.width * W, custom_roi.height * H
            roi_candidates = []
            for bbox, text, conf in raw_boxes:
                tx, ty = bbox[0]
                if roi_x <= tx <= roi_x + roi_w and roi_y <= ty <= roi_y + roi_h:
                    c_name = self.clean_name(text, extra_strip_tokens)
                    if len(c_name) >= 3:
                        roi_candidates.append(c_name)
            primary_name = roi_candidates[0] if roi_candidates else (all_grid_names[0] if all_grid_names else "")
        elif all_grid_names:
            primary_name = all_grid_names[0]
        else:
            primary_name = self.clean_name(raw_text, extra_strip_tokens)

        # 5. Attendee fuzzy matching
        matched_attendee = None
        similarity_score = 0.0

        if attendee_names:
            # First try matching primary active name
            if primary_name:
                matched_attendee, similarity_score, _ = fuzzy_match_attendees(
                    primary_name, attendee_names, min_similarity=0.55
                )

            # If no match on primary, check any name detected in the grid
            if not matched_attendee:
                for candidate in all_grid_names:
                    m, score, _ = fuzzy_match_attendees(candidate, attendee_names, min_similarity=0.60)
                    if score > similarity_score:
                        matched_attendee = m
                        similarity_score = score
                        primary_name = candidate

        # Quality scoring
        effective_conf = ocr_conf if ocr_conf > 0 else 0.90
        combined_score = round(effective_conf * (similarity_score if matched_attendee else 0.8), 4)
        should_commit = combined_score >= 0.70 and matched_attendee is not None
        suggested_chip = matched_attendee or (primary_name if len(primary_name) >= 3 else None)

        return OcrRecognizeResponse(
            app_preset=app_preset.value,
            raw_full_text=raw_text,
            detected_lines=detected_lines,
            cleaned_name=primary_name,
            matched_attendee=matched_attendee,
            similarity_score=round(similarity_score, 3),
            ocr_confidence=round(ocr_conf, 4),
            combined_score=combined_score,
            should_auto_commit=should_commit,
            suggested_chip=suggested_chip,
            active_speaker_detected=active_speaker_detected,
            active_speaker_name=active_speaker_name,
            all_grid_names=all_grid_names,
        )

    def process_request(self, request: OcrRecognizeRequest) -> OcrRecognizeResponse:
        """Process base64 image request."""
        raw_b64 = request.image_base64
        if "," in raw_b64:
            raw_b64 = raw_b64.split(",", 1)[1]

        image_data = base64.b64decode(raw_b64)
        image = Image.open(io.BytesIO(image_data)).convert("RGB")

        return self.process_pil_image(
            image=image,
            app_preset=request.app_preset,
            custom_roi=request.custom_roi,
            attendee_names=request.attendee_names,
            extra_strip_tokens=request.extra_strip_tokens,
        )

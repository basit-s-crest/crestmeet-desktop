"""Tests for the consolidated Pyannote 3.1 ONNX Diarization router."""

from pathlib import Path
import unittest
from fastapi.testclient import TestClient

from crestmeet_rag.api import app

SAMPLE_AUDIO_PATH = Path(__file__).resolve().parents[3] / "A Conversation Between Two People.mp3"


class TestDiarizeRouter(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_diarize_info(self):
        response = self.client.get("/api/diarize/info")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("pyannote/speaker-diarization-3.1", data["engine"])
        self.assertEqual(data["status"], "ready")
        self.assertIn("pyannote-segmentation-3.0", data["segmentation_model"])

    def test_diarize_path(self):
        self.assertTrue(SAMPLE_AUDIO_PATH.exists(), f"Sample audio missing: {SAMPLE_AUDIO_PATH}")
        response = self.client.post(
            "/api/diarize-path",
            json={
                "file_path": str(SAMPLE_AUDIO_PATH),
                "num_speakers": 2,
                "include_rttm": True,
            },
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertGreater(data["total_duration_seconds"], 0)
        self.assertEqual(len(data["speaker_clusters"]), 2)
        self.assertGreater(len(data["diarized_turns"]), 0)
        self.assertIsNotNone(data["rttm"])
        self.assertIn("SPEAKER", data["rttm"])

    def test_diarize_upload_file(self):
        self.assertTrue(SAMPLE_AUDIO_PATH.exists(), f"Sample audio missing: {SAMPLE_AUDIO_PATH}")
        with open(SAMPLE_AUDIO_PATH, "rb") as f:
            response = self.client.post(
                "/api/diarize",
                files={"file": ("test_conv.mp3", f, "audio/mpeg")},
            )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertGreater(len(data["speaker_clusters"]), 0)
        self.assertGreater(len(data["diarized_turns"]), 0)
        self.assertIn("total_duration_seconds", data)
        self.assertIn("speaker_clusters", data)
        self.assertIn("diarized_turns", data)
        self.assertIn("processing_time_ms", data)

    def test_diarize_rttm(self):
        self.assertTrue(SAMPLE_AUDIO_PATH.exists(), f"Sample audio missing: {SAMPLE_AUDIO_PATH}")
        with open(SAMPLE_AUDIO_PATH, "rb") as f:
            response = self.client.post(
                "/api/diarize/rttm",
                files={"file": ("test_conv.mp3", f, "audio/mpeg")},
                data={"num_speakers": 2},
            )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/plain"))
        self.assertIn("SPEAKER", response.text)


if __name__ == "__main__":
    unittest.main()

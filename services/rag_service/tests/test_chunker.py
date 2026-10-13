"""Unit tests for SpeakerTurnChunker."""

from crestmeet_rag.chunking.chunker import SpeakerTurnChunker
from crestmeet_rag.models.schemas import ChunkRequest, TranscriptUtterance


def test_chunker_basic():
    chunker = SpeakerTurnChunker()
    utterances = [
        TranscriptUtterance(speaker="Alice", text="Good morning everyone, let's review the Q3 roadmap.", start_seconds=0.0, end_seconds=5.0),
        TranscriptUtterance(speaker="Bob", text="Sure Alice, our main focus is launching the mobile app.", start_seconds=5.5, end_seconds=12.0),
        TranscriptUtterance(speaker="Charlie", text="I am finishing up the cloud database synchronization.", start_seconds=12.5, end_seconds=20.0),
    ]

    req = ChunkRequest(
        meeting_id="m_test_123",
        meeting_title="Sprint Planning",
        project_name="Apollo",
        meeting_date="2026-10-13",
        utterances=utterances,
        target_tokens=50,
        max_tokens=100,
        overlap_turns=1,
    )

    chunks = chunker.chunk_meeting(req)
    assert len(chunks) >= 1
    assert "Project: Apollo" in chunks[0].context_header
    assert "Meeting: Sprint Planning" in chunks[0].context_header
    assert len(chunks[0].content_hash) == 64
    assert chunks[0].start_seconds == 0.0

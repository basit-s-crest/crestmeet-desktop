"""Two-stage structured action item extractor with late-binding speaker resolution.

Reference: SPEAKER_IDENTITY_AND_ASSIGNMENT_PLAN.md (Section 5 & 13.4)
"""

from __future__ import annotations

import re
import hashlib
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

COMMITMENT_PATTERN = re.compile(
    r"\b("
    r"i will|i'll|i can take|i can handle|i'll do|let me handle|"
    r"can you|could you please|please make sure|please update|please check|"
    r"we need someone to|someone should|we need to|"
    r"by friday|by monday|by tomorrow|by next week|by end of week|"
    r"action item|action items|take that as an action"
    r")\b",
    re.IGNORECASE,
)

DAYS_OF_WEEK = {
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
    "sunday": 6,
}


class StructuredActionItem(BaseModel):
    task: str
    assigner_ref: Optional[str] = None
    assignee_ref: Optional[str] = None
    assignee_text_only: Optional[str] = None
    assignment_type: str = "unassigned"  # volunteered | delegated | proposed_unconfirmed | unassigned
    due_phrase: Optional[str] = None
    due_date: Optional[str] = None  # YYYY-MM-DD
    evidence_turns: List[str] = Field(default_factory=list)
    confidence: float = 0.85
    dedupe_key: Optional[str] = None
    speaker_unresolved: bool = False
    assigner_speaker_id: Optional[str] = None
    assignee_speaker_id: Optional[str] = None
    assignee_person_id: Optional[str] = None


class ActionItemExtractor:
    """Extracts, validates, resolves dates, and maps late-binding speaker IDs for action items."""

    def __init__(self):
        pass

    @staticmethod
    def resolve_due_date(due_phrase: Optional[str], meeting_date: Optional[datetime] = None) -> Optional[str]:
        """Resolves relative date expressions ('by Friday', 'tomorrow') to an exact YYYY-MM-DD date."""
        if not due_phrase or not due_phrase.strip():
            return None

        base_date = meeting_date or datetime.now()
        phrase = due_phrase.lower().strip()

        try:
            if "today" in phrase:
                return base_date.strftime("%Y-%m-%d")
            if "tomorrow" in phrase:
                return (base_date + timedelta(days=1)).strftime("%Y-%m-%d")
            if "next week" in phrase:
                return (base_date + timedelta(days=7)).strftime("%Y-%m-%d")
            if "end of week" in phrase or "eow" in phrase:
                days_ahead = 4 - base_date.weekday()
                if days_ahead <= 0:
                    days_ahead += 7
                return (base_date + timedelta(days=days_ahead)).strftime("%Y-%m-%d")

            # Check specific day of the week
            for day_name, target_weekday in DAYS_OF_WEEK.items():
                if day_name in phrase:
                    days_ahead = target_weekday - base_date.weekday()
                    if days_ahead <= 0:  # Target day already happened this week
                        days_ahead += 7
                    return (base_date + timedelta(days=days_ahead)).strftime("%Y-%m-%d")

            # Match standard ISO format YYYY-MM-DD if explicitly uttered
            iso_match = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", phrase)
            if iso_match:
                return iso_match.group(1)

        except Exception as e:
            logger.debug(f"Failed to resolve due phrase '{due_phrase}': {e}")

        return None

    @staticmethod
    def compute_dedupe_key(meeting_id: str, evidence_turns: List[str], task_snippet: str) -> str:
        """Deterministic dedupe hash so re-processing a meeting will never duplicate action items."""
        sorted_turns = ",".join(sorted(evidence_turns)) if evidence_turns else "noturns"
        norm_task = re.sub(r"\W+", "", task_snippet.lower()[:30])
        raw_key = f"{meeting_id}:{sorted_turns}:{norm_task}"
        return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()

    def detect_candidate_turns(self, turns: List[Dict]) -> List[int]:
        """Candidate detection: identifies indices of speaker turns containing commitment language."""
        candidate_indices = []
        for idx, turn in enumerate(turns):
            text = turn.get("text", "")
            if COMMITMENT_PATTERN.search(text):
                candidate_indices.append(idx)
        return candidate_indices

    def parse_action_items_from_summary(
        self,
        raw_items: List,
        meeting_id: str,
        meeting_date: Optional[datetime],
        speakers: List[Dict],
        people: List[Dict],
    ) -> List[StructuredActionItem]:
        """
        Parses action items into StructuredActionItem objects with late-binding
        links to meeting_speakers and people.
        """
        resolved_items: List[StructuredActionItem] = []

        # Build speaker lookup maps
        speaker_by_cluster = {s.get("cluster_key"): s for s in speakers if s.get("cluster_key")}
        speaker_by_name = {}
        for s in speakers:
            name = s.get("display_name")
            if name:
                norm = name.strip().lower()
                speaker_by_name[norm] = s
                first = norm.split()[0]
                if first not in speaker_by_name:
                    speaker_by_name[first] = s

        # Map person_id -> speaker in this meeting (if a speaker is linked to a person)
        speaker_by_person_id = {
            s.get("person_id"): s
            for s in speakers
            if s.get("person_id")
        }

        # Build people lookup maps (by display_name, alias, email)
        person_by_name = {}
        for p in people:
            d_name = p.get("display_name")
            if d_name:
                norm_d = d_name.strip().lower()
                person_by_name[norm_d] = p
                first = norm_d.split()[0]
                if first not in person_by_name:
                    person_by_name[first] = p

        person_by_alias = {}
        for p in people:
            for alias in p.get("aliases") or []:
                person_by_alias[alias.strip().lower()] = p

        def match_speaker_and_person(ref: str) -> Tuple[Optional[Dict], Optional[Dict]]:
            norm = ref.strip().lower()
            if ref in speaker_by_cluster:
                spk = speaker_by_cluster[ref]
                p = next((x for x in people if str(x.get("id")) == str(spk.get("person_id"))), None) if spk.get("person_id") else None
                return spk, p

            if norm in speaker_by_name:
                spk = speaker_by_name[norm]
                p = next((x for x in people if str(x.get("id")) == str(spk.get("person_id"))), None) if spk.get("person_id") else None
                return spk, p

            p = person_by_name.get(norm) or person_by_alias.get(norm)
            if p:
                spk = speaker_by_person_id.get(p.get("id")) or speaker_by_person_id.get(str(p.get("id")))
                return spk, p

            return None, None

        for raw in raw_items:
            if isinstance(raw, str):
                task = raw.strip()
                assignee_text = None
                assigner_text = None
                due_phrase = None
                assignment_type = "unassigned"
                evidence_turns = []
                confidence = 0.8
            elif isinstance(raw, dict):
                task = raw.get("description") or raw.get("task") or raw.get("content") or ""
                assignee_text = raw.get("assignee") or raw.get("owner") or raw.get("assignee_ref")
                assigner_text = raw.get("assigner") or raw.get("assigner_ref")
                due_phrase = raw.get("due_date") or raw.get("due_phrase")
                assignment_type = raw.get("assignment_type") or ("delegated" if assignee_text else "unassigned")
                evidence_turns = raw.get("evidence_turns") or raw.get("evidence_turn_ids") or []
                confidence = float(raw.get("confidence") or 0.85)
            else:
                continue

            if not task or len(task.strip()) < 3:
                continue

            # 1. Resolve Due Date
            due_date = self.resolve_due_date(due_phrase, meeting_date)

            # 2. Compute Dedupe Key
            dedupe_key = self.compute_dedupe_key(meeting_id, evidence_turns, task)

            item = StructuredActionItem(
                task=task.strip(),
                assigner_ref=str(assigner_text) if assigner_text else None,
                assignee_ref=str(assignee_text) if assignee_text else None,
                assignment_type=assignment_type,
                due_phrase=str(due_phrase) if due_phrase else None,
                due_date=due_date,
                evidence_turns=evidence_turns,
                confidence=confidence,
                dedupe_key=dedupe_key,
                speaker_unresolved=False,
            )

            # 3. Resolve Assignee to meeting_speakers or people
            if assignee_text:
                matched_speaker, matched_person = match_speaker_and_person(str(assignee_text))

                if matched_speaker:
                    item.assignee_speaker_id = str(matched_speaker.get("id"))
                    if not matched_speaker.get("display_name"):
                        item.speaker_unresolved = True
                elif matched_person:
                    item.assignee_text_only = str(assignee_text).strip()
                    item.assignee_person_id = str(matched_person.get("id"))
                else:
                    item.assignee_text_only = str(assignee_text).strip()
                    item.speaker_unresolved = True
            else:
                item.assignment_type = "unassigned"
                item.speaker_unresolved = True

            # 4. Resolve Assigner to meeting_speakers
            if assigner_text:
                matched_assigner, _ = match_speaker_and_person(str(assigner_text))
                if matched_assigner:
                    item.assigner_speaker_id = str(matched_assigner.get("id"))

            resolved_items.append(item)

        return resolved_items

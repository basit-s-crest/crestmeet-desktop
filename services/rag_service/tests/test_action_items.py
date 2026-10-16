import unittest
from datetime import datetime
from crestmeet_rag.action_items.extractor import ActionItemExtractor, StructuredActionItem


class TestActionItemExtractor(unittest.TestCase):
    def setUp(self):
        self.extractor = ActionItemExtractor()

    def test_candidate_detection(self):
        turns = [
            {"turn_id": "T1", "text": "Hello everyone, thanks for joining."},
            {"turn_id": "T2", "text": "Alex, can you please update the Stripe webhook by Friday?"},
            {"turn_id": "T3", "text": "Sure, I will handle that tomorrow."},
            {"turn_id": "T4", "text": "Sounds good, let's wrap up."},
        ]
        candidates = self.extractor.detect_candidate_turns(turns)
        self.assertEqual(candidates, [1, 2])

    def test_date_resolution(self):
        # Wednesday, 2026-10-14
        meeting_date = datetime(2026, 10, 14, 10, 0, 0)

        # Tomorrow should be Thursday 2026-10-15
        self.assertEqual(self.extractor.resolve_due_date("tomorrow", meeting_date), "2026-10-15")

        # Friday should be 2026-10-16
        self.assertEqual(self.extractor.resolve_due_date("by Friday afternoon", meeting_date), "2026-10-16")

        # Next week should be 2026-10-21
        self.assertEqual(self.extractor.resolve_due_date("next week", meeting_date), "2026-10-21")

    def test_dedupe_key_stability(self):
        k1 = self.extractor.compute_dedupe_key("m1", ["T1", "T2"], "Update Stripe webhooks")
        k2 = self.extractor.compute_dedupe_key("m1", ["T2", "T1"], "Update Stripe webhooks!")
        self.assertEqual(k1, k2)

    def test_late_binding_speaker_resolution(self):
        speakers = [
            {"id": "spk-001", "cluster_key": "mic:S0", "channel": "mic", "display_name": "Maya Chen", "person_id": "p-001"},
            {"id": "spk-002", "cluster_key": "sys:S1", "channel": "system", "display_name": "Alex", "person_id": None},
        ]
        people = [
            {"id": "p-001", "display_name": "Maya Chen", "email": "maya@example.com", "aliases": ["Maya"]},
            {"id": "p-002", "display_name": "David Miller", "email": "david@example.com", "aliases": ["Dave"]},
        ]

        raw_items = [
            {
                "description": "Update Stripe webhooks and tests",
                "assignee": "Maya",
                "assigner": "Alex",
                "due_date": "by Friday",
                "evidence_turns": ["T10", "T11"],
                "assignment_type": "volunteered",
            },
            {
                "description": "Send meeting minutes to external client",
                "assignee": "Dave",
                "assigner": "mic:S0",
                "due_date": "tomorrow",
                "evidence_turns": ["T15"],
                "assignment_type": "delegated",
            },
            {
                "description": "Someone should clean up the old staging server",
                "assignee": None,
                "evidence_turns": ["T20"],
            },
        ]

        meeting_date = datetime(2026, 10, 14, 12, 0, 0)
        resolved = self.extractor.parse_action_items_from_summary(raw_items, "meeting-xyz", meeting_date, speakers, people)

        self.assertEqual(len(resolved), 3)

        # Item 1: Maya matched to speaker spk-001, Alex matched to spk-002
        self.assertEqual(resolved[0].assignee_speaker_id, "spk-001")
        self.assertEqual(resolved[0].assigner_speaker_id, "spk-002")
        self.assertEqual(resolved[0].due_date, "2026-10-16")
        self.assertFalse(resolved[0].speaker_unresolved)

        # Item 2: Dave matched to person p-002 (text-only alias match), Assigner matched to mic:S0
        self.assertEqual(resolved[1].assignee_person_id, "p-002")
        self.assertEqual(resolved[1].assigner_speaker_id, "spk-001")
        self.assertEqual(resolved[1].due_date, "2026-10-15")
        self.assertFalse(resolved[1].speaker_unresolved)

        # Item 3: Unassigned
        self.assertEqual(resolved[2].assignment_type, "unassigned")
        self.assertTrue(resolved[2].speaker_unresolved)


if __name__ == "__main__":
    unittest.main()

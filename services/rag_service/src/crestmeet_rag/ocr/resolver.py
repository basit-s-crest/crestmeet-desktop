"""Multi-modal OCR and Transcript Bayesian Speaker Resolution Engine.

Implements the Single-Frame Evidence Baseline and Association Model:
1. Active speaker border detection & RapidOCR on participant tile label crops.
2. Neighbor frame consistency (pin/spotlight detection) and lift weighting.
3. Transcript conversational cues (self-introduction, handoff address, thank-you acknowledgment).
4. Bayesian posterior probability estimation over calendar attendees + OTHER prior.
5. Production of the Meeting Dossier audit JSON for UI explanations and corrections.
"""

import base64
import io
import math
import re
from typing import Any, Dict, List, Optional, Tuple
import numpy as np
from PIL import Image

from crestmeet_rag.ocr.engine import ScreenOcrEngine, DEFAULT_STRIP_TOKENS
from crestmeet_rag.ocr.schemas import (
    AppPreset,
    ClusterResolution,
    MeetingFrameInput,
    MeetingSegmentInput,
    ResolveMeetingSpeakersRequest,
    ResolveMeetingSpeakersResponse,
)
from crestmeet_rag.ocr.voting import compute_string_similarity, fuzzy_match_attendees


# Regex patterns for conversational cues in meeting transcripts
RE_SELF_INTRO = re.compile(
    r"(?:^|\b)(?:hi|hello|hey)?[\s,]*(?:this is|i'm|i am|my name is)\s+([A-Za-z]{2,}(?:\s+[A-Za-z]{2,})?)",
    re.IGNORECASE,
)
RE_ADDRESSED_BEFORE = re.compile(
    r"(?:over to|what do you think|can you chime in|your thoughts|take it away)[\s,]+([A-Za-z]{2,}(?:\s+[A-Za-z]{2,})?)|([A-Za-z]{2,}(?:\s+[A-Za-z]{2,})?)[,\s]+(?:what do you think|can you|go ahead)",
    re.IGNORECASE,
)
RE_THANKED_AFTER = re.compile(
    r"(?:^|\b)(?:thanks|thank you|much appreciated|great point)[\s,]+([A-Za-z]{2,}(?:\s+[A-Za-z]{2,})?)",
    re.IGNORECASE,
)


def extract_transcript_cues(
    segments: List[MeetingSegmentInput],
    attendees: List[str],
) -> Dict[str, List[Dict[str, Any]]]:
    """
    Scans speech segments and their neighboring turns for direct conversational cues.
    Returns: { cluster_key: [ { 'type': str, 'name': str, 'matched_attendee': str, 'similarity': float, 'text': str, 'lr': float } ] }
    """
    cues_by_cluster: Dict[str, List[Dict[str, Any]]] = {}
    if not segments or not attendees:
        return cues_by_cluster

    # Sort segments by start time
    sorted_segments = sorted(segments, key=lambda s: s.start_time)
    num_segs = len(sorted_segments)

    for idx, seg in enumerate(sorted_segments):
        cluster = seg.cluster_key
        text = seg.transcript_text.strip()
        if not text:
            continue

        # 1. Self-introduction within the current segment: "Hi, this is Priya"
        match_intro = RE_SELF_INTRO.search(text)
        if match_intro:
            raw_candidate = match_intro.group(1).strip()
            best_att, sim, _ = fuzzy_match_attendees(raw_candidate, attendees, min_similarity=0.60)
            if best_att:
                cues_by_cluster.setdefault(cluster, []).append({
                    "type": "self_introduction",
                    "raw_name": raw_candidate,
                    "name": best_att,
                    "similarity": sim,
                    "text": text[:80],
                    "lr": 10.0,
                })

        # 2. Addressed by previous speaker right before answering: "Priya, what do you think?"
        if idx > 0:
            prev_seg = sorted_segments[idx - 1]
            if prev_seg.cluster_key != cluster:
                prev_text = prev_seg.transcript_text.strip()
                match_addressed = RE_ADDRESSED_BEFORE.search(prev_text)
                if match_addressed:
                    raw_candidate = (match_addressed.group(1) or match_addressed.group(2) or "").strip()
                    if raw_candidate:
                        best_att, sim, _ = fuzzy_match_attendees(raw_candidate, attendees, min_similarity=0.60)
                        if best_att:
                            cues_by_cluster.setdefault(cluster, []).append({
                                "type": "addressed_before",
                                "raw_name": raw_candidate,
                                "name": best_att,
                                "similarity": sim,
                                "text": prev_text[-80:],
                                "lr": 3.0,
                            })

        # 3. Thanked by subsequent speaker right after: "Thanks, Priya"
        if idx < num_segs - 1:
            next_seg = sorted_segments[idx + 1]
            if next_seg.cluster_key != cluster:
                next_text = next_seg.transcript_text.strip()
                match_thanks = RE_THANKED_AFTER.search(next_text)
                if match_thanks:
                    raw_candidate = match_thanks.group(1).strip()
                    best_att, sim, _ = fuzzy_match_attendees(raw_candidate, attendees, min_similarity=0.60)
                    if best_att:
                        cues_by_cluster.setdefault(cluster, []).append({
                            "type": "thanked_after",
                            "raw_name": raw_candidate,
                            "name": best_att,
                            "similarity": sim,
                            "text": next_text[:80],
                            "lr": 4.0,
                        })

    return cues_by_cluster


def resolve_meeting_speakers(
    request: ResolveMeetingSpeakersRequest,
    ocr_engine: ScreenOcrEngine,
) -> ResolveMeetingSpeakersResponse:
    """
    Executes the full end-to-end speaker naming pipeline:
    - Analyzes candidate native/video frames with ScreenOcrEngine
    - Checks neighbor tile consistency to neutralize pinned/spotlight tiles
    - Extracts transcript conversational cues
    - Computes Bayesian probabilities
    - Builds the JSON audit dossier
    """
    attendees = [a.strip() for a in request.attendees if a.strip() and a.strip().lower() not in ("you", "me")]
    
    # 1. Process candidate frames
    raw_frame_observations: List[Dict[str, Any]] = []
    
    for frame in request.frames:
        try:
            raw_b64 = frame.image_base64
            if "," in raw_b64:
                raw_b64 = raw_b64.split(",", 1)[1]
            image_data = base64.b64decode(raw_b64)
            img = Image.open(io.BytesIO(image_data)).convert("RGB")

            # Run full active-tile detection + OCR recognition on crops
            response = ocr_engine.process_pil_image(
                image=img,
                app_preset=request.app_preset,
                attendee_names=attendees,
            )

            # Detect the active speaker tile coordinates if available
            img_np = np.array(img)
            bgr = img_np[:, :, ::-1] if img_np.ndim == 3 else img_np
            tile_rect = ocr_engine.detect_active_speaker_tile(bgr)

            raw_frame_observations.append({
                "frame_id": frame.frame_id,
                "cluster_key": frame.cluster_key,
                "timestamp": frame.timestamp,
                "tile_rect": tile_rect,
                "active_speaker_detected": response.active_speaker_detected,
                "active_speaker_name": response.active_speaker_name,
                "cleaned_name": response.cleaned_name,
                "matched_attendee": response.matched_attendee,
                "similarity_score": response.similarity_score,
                "ocr_confidence": response.ocr_confidence,
                "all_grid_names": response.all_grid_names,
            })
        except Exception as e:
            # Skip corrupted/unreadable frame
            continue

    # 2. Neighbor consistency and global tile lift analysis
    # If the exact same tile rectangle is highlighted across >= 3 different clusters or across a large time gap,
    # it indicates a pinned/spotlighted participant or presentation.
    sorted_obs = sorted(raw_frame_observations, key=lambda x: x["timestamp"])
    tile_cluster_counts: Dict[Tuple[int, int], set] = {}
    for obs in sorted_obs:
        r = obs.get("tile_rect")
        if r:
            # Quantize coordinates to 25px grid to group near-identical tiles
            key = (r[0] // 25, r[1] // 25)
            tile_cluster_counts.setdefault(key, set()).add(obs["cluster_key"])

    # A tile is flagged as pinned/spotlight only if it is persistently highlighted across >= 3 distinct clusters
    for obs in sorted_obs:
        r = obs.get("tile_rect")
        if r:
            key = (r[0] // 25, r[1] // 25)
            if len(tile_cluster_counts.get(key, set())) >= 3:
                obs["is_pinned_or_spotlight"] = True

    # 3. Extract transcript cues
    transcript_cues_by_cluster = extract_transcript_cues(request.segments, attendees)

    # 4. Bayesian Probability Calculation per Cluster
    # Candidate set: known attendees + discovered names on screen + "OTHER"
    # (Per SINGLE_FRAME_EVIDENCE_BASELINE_POC.md: candidates include names seen on screen)
    ui_noise_words = {
        "crestmeet", "devtools", "search", "untitled", "unknown", "sunny",
        "presentation", "presenting", "muted", "reactions", "participants", "askgemini"
    }
    discovered_names: List[str] = []
    for obs in sorted_obs:
        for candidate_text in [obs.get("active_speaker_name"), obs.get("cleaned_name")]:
            if candidate_text and len(candidate_text.strip()) >= 3:
                norm = candidate_text.strip()
                if not any(w in norm.lower() for w in ui_noise_words):
                    if norm not in attendees and norm not in discovered_names:
                        discovered_names.append(norm)

    candidate_names = list(attendees) + discovered_names
    if "OTHER" not in candidate_names:
        candidate_names.append("OTHER")

    num_candidates = len(candidate_names)
    prior_prob = 1.0 / max(num_candidates, 1)

    all_clusters = sorted(list({
        *(f.cluster_key for f in request.frames),
        *(s.cluster_key for s in request.segments),
    }))

    decisions: List[ClusterResolution] = []
    dossier_speakers: List[Dict[str, Any]] = []

    for cluster in all_clusters:
        cluster_frames = [o for o in sorted_obs if o["cluster_key"] == cluster]
        cluster_cues = transcript_cues_by_cluster.get(cluster, [])

        # Log-odds dictionary for each candidate
        # start with log prior
        log_odds: Dict[str, float] = {name: math.log(prior_prob) for name in candidate_names}
        reasons: List[str] = []
        raw_names: List[str] = []
        evidence_types_seen = set()

        # A. Highlight observations from frames
        valid_highlight_hits: Dict[str, int] = {}
        for obs in cluster_frames:
            best_name = obs.get("matched_attendee") or obs.get("active_speaker_name") or obs.get("cleaned_name")
            if best_name and len(best_name) >= 2:
                raw_names.append(best_name)

            is_pinned = obs.get("is_pinned_or_spotlight", False)

            if obs.get("active_speaker_detected") and best_name and best_name in candidate_names:
                att = best_name
                conf = obs.get("ocr_confidence", 0.9)
                sim = obs.get("similarity_score", 1.0) if obs.get("matched_attendee") else 0.85
                valid_highlight_hits[att] = valid_highlight_hits.get(att, 0) + 1
                evidence_types_seen.add("highlight")

                # Frame LR: alpha / ((1 - alpha) / (N - 1))
                alpha = min(max(conf * sim, 0.50), 0.95)
                denom = max((1.0 - alpha) / max(num_candidates - 1, 1), 0.01)
                lr = min(alpha / denom, 8.0)

                if is_pinned:
                    # Neutralize pinned tile: reduce likelihood weight rather than dropping completely
                    lr = max(lr * 0.35, 1.2)
                    reasons.append(f"tile_pinned_discounted_at_{obs['timestamp']:.1f}s")

                if att in log_odds:
                    log_odds[att] += math.log(lr)
                reasons.append(f"highlight_seen_at_{obs['timestamp']:.1f}s({att})")

            elif best_name and best_name in candidate_names:
                # Grid tile label seen (without explicit border)
                att = best_name
                evidence_types_seen.add("grid_label")
                if att in log_odds:
                    log_odds[att] += math.log(2.5)
                reasons.append(f"grid_label_seen_at_{obs['timestamp']:.1f}s({att})")

        # B. Transcript conversational cues
        for cue in cluster_cues:
            att = cue["name"]
            lr = cue["lr"]
            evidence_types_seen.add(cue["type"])
            if att in log_odds:
                log_odds[att] += math.log(lr)
            reasons.append(f"{cue['type']}: {att} ('{cue['text']}')")

        # Softmax over candidates to obtain posterior probabilities P(c = n)
        max_log = max(log_odds.values())
        exp_scores = {name: math.exp(val - max_log) for name, val in log_odds.items()}
        total_exp = sum(exp_scores.values())
        posteriors = {name: (score / total_exp) for name, score in exp_scores.items()}

        # Sort candidate ranking
        ranked_candidates = sorted(posteriors.items(), key=lambda item: item[1], reverse=True)
        top_name, top_prob = ranked_candidates[0]
        runner_up_name, runner_up_prob = ranked_candidates[1] if len(ranked_candidates) > 1 else (None, 0.0)

        # Decision rules:
        # Commit if P >= 0.82 AND (at least 2 distinct evidence types OR >= 2 highlight agreement)
        # Suggest if P >= 0.48
        # Otherwise Unknown
        committed_name = None
        suggested_name = None

        is_other = top_name == "OTHER"
        can_commit = (
            not is_other
            and top_prob >= 0.82
            and (
                len(evidence_types_seen) >= 2
                or valid_highlight_hits.get(top_name, 0) >= 2
                or (len(cluster_cues) >= 1 and valid_highlight_hits.get(top_name, 0) >= 1)
            )
        )
        can_suggest = not is_other and top_prob >= 0.48


        if can_commit:
            committed_name = top_name
        elif can_suggest:
            suggested_name = top_name

        confidence = round(top_prob, 3)

        decisions.append(
            ClusterResolution(
                cluster_key=cluster,
                committed_name=committed_name,
                suggested_name=suggested_name,
                confidence=confidence,
                evidence_count=len(cluster_frames) + len(cluster_cues),
                reasons=reasons,
                evidence_types=len(evidence_types_seen),
                raw_ocr_names=list(set(raw_names)),
                runner_up_name=runner_up_name,
                runner_up_score=round(runner_up_prob, 3),
            )
        )

        dossier_speakers.append({
            "cluster": cluster,
            "frames_analyzed": len(cluster_frames),
            "observations": cluster_frames,
            "text_cues": cluster_cues,
            "ranked": [{"name": n, "probability": round(p, 4)} for n, p in ranked_candidates],
            "decision": {
                "state": "commit" if committed_name else ("suggest" if suggested_name else "unknown"),
                "name": committed_name or suggested_name,
                "confidence": confidence,
                "reasons": reasons,
                "evidence_types": len(evidence_types_seen),
            },
        })

    # 5. Greedy 1-to-1 conflict check:
    # If two clusters committed to the exact same person, assign to the one with highest confidence
    # and downgrade the second to a suggestion ("Potential split cluster")
    claimed_commits: Dict[str, ClusterResolution] = {}
    for d in decisions:
        if d.committed_name:
            if d.committed_name in claimed_commits:
                prev = claimed_commits[d.committed_name]
                if d.confidence > prev.confidence:
                    prev.suggested_name = prev.committed_name
                    prev.committed_name = None
                    prev.reasons.append("downgraded_to_suggestion_duplicate_claim")
                    claimed_commits[d.committed_name] = d
                else:
                    d.suggested_name = d.committed_name
                    d.committed_name = None
                    d.reasons.append("downgraded_to_suggestion_duplicate_claim")
            else:
                claimed_commits[d.committed_name] = d

    # 6. Build the Meeting Dossier JSON
    dossier = {
        "meeting_id": request.meeting_id,
        "app_preset": request.app_preset.value,
        "total_frames_evaluated": len(request.frames),
        "total_segments_evaluated": len(request.segments),
        "attendees": attendees,
        "speakers": dossier_speakers,
    }

    auto_committed = sum(1 for d in decisions if d.committed_name)
    suggested = sum(1 for d in decisions if d.suggested_name)

    return ResolveMeetingSpeakersResponse(
        meeting_id=request.meeting_id,
        decisions=decisions,
        dossier=dossier,
        total_clusters_resolved=len(decisions),
        auto_committed_count=auto_committed,
        suggested_count=suggested,
    )

"""OCR Voting and Attendee Fuzzy-Matching Solver.

Matches candidates against calendar attendees and solves 1-to-1 speaker assignment
using margin-based multi-observation voting.
"""

from difflib import SequenceMatcher
from typing import Dict, List, Optional, Tuple
from crestmeet_rag.ocr.schemas import (
    OcrObservationInput,
    SpeakerDecision,
    VotingSimulationResponse,
)


def compute_string_similarity(a: str, b: str) -> float:
    """Compute normalized sequence and token-level similarity between two names (0.0 to 1.0)."""
    norm_a = a.strip().lower()
    norm_b = b.strip().lower()
    if not norm_a or not norm_b:
        return 0.0
    if norm_a == norm_b:
        return 1.0

    words_a = set(norm_a.split())
    words_b = set(norm_b.split())

    # Exact token match (e.g. "Priya" in "Priya Sharma")
    if words_a and words_b:
        if words_a.issubset(words_b) or words_b.issubset(words_a):
            return 0.88

        # First names match
        first_a = norm_a.split()[0]
        first_b = norm_b.split()[0]
        if first_a == first_b and len(first_a) >= 3:
            return 0.85

    # Sub-phrase match
    if norm_a in norm_b or norm_b in norm_a:
        min_len = min(len(norm_a), len(norm_b))
        max_len = max(len(norm_a), len(norm_b))
        return max(min_len / max_len, 0.78)

    return SequenceMatcher(None, norm_a, norm_b).ratio()



def fuzzy_match_attendees(
    cleaned_ocr_text: str,
    attendees: List[str],
    min_similarity: float = 0.50,
) -> Tuple[Optional[str], float, Dict[str, float]]:
    """
    Fuzzy match candidate OCR text against known attendee list.
    Returns (best_matched_attendee, similarity_score, all_scores_dict).
    """
    if not cleaned_ocr_text or not attendees:
        return None, 0.0, {}

    all_scores: Dict[str, float] = {}
    best_attendee: Optional[str] = None
    best_score: float = 0.0

    for att in attendees:
        score = compute_string_similarity(cleaned_ocr_text, att)
        all_scores[att] = round(score, 4)
        if score > best_score:
            best_score = score
            best_attendee = att

    if best_score >= min_similarity:
        return best_attendee, round(best_score, 4), all_scores
    return None, round(best_score, 4), all_scores


def solve_voting(
    observations: List[OcrObservationInput],
    unresolved_clusters: List[str],
    auto_commit_threshold: float = 0.65,
    suggestion_threshold: float = 0.45,
    margin_threshold: float = 0.15,
    min_observations: int = 1,
) -> VotingSimulationResponse:
    """
    Aggregates multi-observation OCR votes per cluster, evaluates margin over runner-up,
    and enforces strict 1-to-1 assignment so no two clusters receive the same person.
    """
    # 1. Accumulate quality score: q = ocr_confidence * match_similarity * segment_purity
    # votes[cluster_key][candidate_name] = (total_q, count)
    votes: Dict[str, Dict[str, Tuple[float, int]]] = {}

    for obs in observations:
        q = max(obs.ocr_confidence * obs.match_similarity * obs.segment_purity, 0.01)
        cluster_entry = votes.setdefault(obs.cluster_key, {})
        curr_q, curr_cnt = cluster_entry.get(obs.candidate_name, (0.0, 0))
        cluster_entry[obs.candidate_name] = (curr_q + q, curr_cnt + 1)

    # 2. Per cluster, calculate top candidate, relative share, and runner-up margin
    cluster_candidates = []  # (cluster, name, share, margin, count, runner_up_name, runner_up_score)

    for cluster in unresolved_clusters:
        candidate_map = votes.get(cluster)
        if not candidate_map:
            continue

        sorted_candidates = sorted(
            candidate_map.items(), key=lambda item: item[1][0], reverse=True
        )

        top_name, (top_score, count) = sorted_candidates[0]
        total_cluster_score = sum(s for s, _ in candidate_map.values())
        runner_up_name = sorted_candidates[1][0] if len(sorted_candidates) > 1 else None
        runner_up_score = sorted_candidates[1][1][0] if len(sorted_candidates) > 1 else 0.0

        relative_share = top_score / total_cluster_score if total_cluster_score > 0 else 0.0
        margin = (
            (top_score - runner_up_score) / total_cluster_score
            if total_cluster_score > 0
            else 0.0
        )

        cluster_candidates.append(
            {
                "cluster": cluster,
                "name": top_name,
                "share": relative_share,
                "margin": margin,
                "count": count,
                "runner_up_name": runner_up_name,
                "runner_up_score": runner_up_score,
            }
        )

    # 3. Sort candidates greedily by relative share
    cluster_candidates.sort(key=lambda x: x["share"], reverse=True)

    claimed_names = set()
    decisions_map: Dict[str, SpeakerDecision] = {}

    for item in cluster_candidates:
        cluster = item["cluster"]
        name = item["name"]
        share = item["share"]
        margin = item["margin"]
        count = item["count"]
        r_name = item["runner_up_name"]
        r_score = item["runner_up_score"]

        if name in claimed_names:
            # Downgrade to suggestion chip since stronger cluster claimed this person
            decisions_map[cluster] = SpeakerDecision(
                cluster_key=cluster,
                committed_name=None,
                suggested_name=name,
                confidence=round(share * 0.70, 4),
                vote_count=count,
                runner_up_name=r_name,
                runner_up_score=round(r_score, 4),
            )
            continue

        can_commit = (
            share >= auto_commit_threshold
            and margin >= margin_threshold
            and count >= min_observations
        )

        if can_commit:
            claimed_names.add(name)
            decisions_map[cluster] = SpeakerDecision(
                cluster_key=cluster,
                committed_name=name,
                suggested_name=None,
                confidence=round(share, 4),
                vote_count=count,
                runner_up_name=r_name,
                runner_up_score=round(r_score, 4),
            )
        elif share >= suggestion_threshold:
            decisions_map[cluster] = SpeakerDecision(
                cluster_key=cluster,
                committed_name=None,
                suggested_name=name,
                confidence=round(share, 4),
                vote_count=count,
                runner_up_name=r_name,
                runner_up_score=round(r_score, 4),
            )
        else:
            decisions_map[cluster] = SpeakerDecision(
                cluster_key=cluster,
                committed_name=None,
                suggested_name=None,
                confidence=round(share, 4),
                vote_count=count,
                runner_up_name=r_name,
                runner_up_score=round(r_score, 4),
            )

    # Fill in unresolved clusters with zero votes
    for cluster in unresolved_clusters:
        if cluster not in decisions_map:
            decisions_map[cluster] = SpeakerDecision(
                cluster_key=cluster,
                committed_name=None,
                suggested_name=None,
                confidence=0.0,
                vote_count=0,
            )

    decisions = [decisions_map[k] for k in unresolved_clusters if k in decisions_map]

    auto_committed = sum(1 for d in decisions if d.committed_name is not None)
    suggested = sum(
        1 for d in decisions if d.committed_name is None and d.suggested_name is not None
    )
    unresolved = sum(
        1 for d in decisions if d.committed_name is None and d.suggested_name is None
    )

    return VotingSimulationResponse(
        decisions=decisions,
        total_clusters=len(unresolved_clusters),
        auto_committed_count=auto_committed,
        suggested_count=suggested,
        unresolved_count=unresolved,
    )

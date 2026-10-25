"""Pyannote 3.1 ONNX Extended Diarization Engine (Original Reference Backup).

Based on samson6460/pyannote-onnx-extended:
- ONNX Runtime implementation of Pyannote Speaker Diarization 3.1
- Overlap handling via permutation reordering and average confidence stitching
- Log-mel spectrogram extraction matching WeSpeaker ResNet34-LM
- Two-stage clustering: core speaker clustering on long segments, nearest-centroid
  assignment for short utterances to eliminate over-splitting.
"""

import io
from itertools import permutations
import logging
from pathlib import Path
import time
from typing import Any, BinaryIO, Dict, List, Optional, Tuple, Union

import av
from huggingface_hub import hf_hub_download
import librosa
import numpy as np
import onnxruntime as ort
from pyannote.core import Annotation, Segment, Timeline
from scipy.spatial.distance import cdist
from sklearn.cluster import AgglomerativeClustering
import soundfile as sf

from crestmeet_rag.pyannote_3_0.schemas import (
    ClusterSummary,
    DiarizationResponse,
    DiarizedTurn,
)

logger = logging.getLogger("crestmeet_rag.pyannote_3_0")


def _decode_audio(
    input_file: Union[str, Path, BinaryIO, bytes],
    sampling_rate: int = 16000,
) -> np.ndarray:
    """Decode any audio format (WAV, MP3, etc.) to 16kHz mono float32."""
    if isinstance(input_file, bytes):
        input_file = io.BytesIO(input_file)
    elif isinstance(input_file, Path):
        input_file = str(input_file)

    resampler = av.audio.resampler.AudioResampler(
        format="s16",
        layout="mono",
        rate=sampling_rate,
    )

    raw_buffer = io.BytesIO()
    dtype = None

    with av.open(input_file, mode="r", metadata_errors="ignore") as container:
        frames = container.decode(audio=0)
        for frame in frames:
            resampled = resampler.resample(frame)
            if resampled:
                for rf in resampled:
                    arr = rf.to_ndarray()
                    dtype = arr.dtype
                    raw_buffer.write(arr.tobytes())

    audio_bytes = raw_buffer.getvalue()
    if not audio_bytes or dtype is None:
        return np.array([], dtype=np.float32)

    audio = np.frombuffer(audio_bytes, dtype=dtype)
    return (audio / 32768.0).astype(np.float32)


class Pyannote3EngineOriginal:
    """Pyannote 3.1 ONNX Extended Speaker Diarization Engine (Original)."""

    def __init__(
        self,
        providers: Optional[List[str]] = None,
        onset: float = 0.50,
        offset: float = 0.50,
        min_duration_on: float = 0.50,
        min_duration_off: float = 0.30,
    ):
        self.providers = providers or ["CPUExecutionProvider"]
        self.onset = onset
        self.offset = offset
        self.min_duration_on = min_duration_on
        self.min_duration_off = min_duration_off

        self.sample_rate = 16000
        self.duration = 10.0  # Segmentation model duration (10s)
        self.step = 5.0      # 50% overlap

        self.segmentation_session: Optional[ort.InferenceSession] = None
        self.embedding_session: Optional[ort.InferenceSession] = None
        self.model_name = "pyannote/speaker-diarization-3.1 (ONNX Extended)"
        self.emb_model_name = "onnx-community/wespeaker-voxceleb-resnet34-LM"

        self._init_models()

    def _init_models(self):
        try:
            logger.info("Resolving Pyannote 3.0 segmentation ONNX model...")
            seg_path = hf_hub_download(
                repo_id="onnx-community/pyannote-segmentation-3.0",
                filename="onnx/model.onnx",
            )
            self.segmentation_session = ort.InferenceSession(seg_path, providers=self.providers)
            logger.info(f"Loaded segmentation model from {seg_path}")
        except Exception as e:
            logger.error(f"Failed to load segmentation ONNX: {e}")
            self.segmentation_session = None

        try:
            logger.info("Resolving WeSpeaker ONNX embedding model...")
            emb_path = hf_hub_download(
                repo_id="onnx-community/wespeaker-voxceleb-resnet34-LM",
                filename="onnx/model.onnx",
            )
            self.embedding_session = ort.InferenceSession(emb_path, providers=self.providers)
            logger.info(f"Loaded embedding model from {emb_path}")
        except Exception as e:
            logger.error(f"Failed to load embedding ONNX: {e}")
            self.embedding_session = None

    @staticmethod
    def sample2frame(sample: int) -> int:
        return (sample - 721) // 270

    @staticmethod
    def reorder(overlap_prob: np.ndarray, prob: np.ndarray) -> np.ndarray:
        perms = [np.array(perm).T for perm in permutations(prob.T)]
        perms = np.array(perms)
        sum_perms = np.sum(perms[:, : overlap_prob.shape[0], :] - overlap_prob, axis=1)
        diffs = np.sum(np.abs(sum_perms), axis=1)
        return perms[np.argmin(diffs)]

    def load_audio(self, audio_bytes: bytes) -> Tuple[np.ndarray, int]:
        """Decode audio bytes to 16kHz mono float32."""
        waveform = _decode_audio(audio_bytes, sampling_rate=self.sample_rate)
        return waveform, self.sample_rate

    def load_audio_from_file(self, file_path: Path) -> Tuple[np.ndarray, int]:
        """Read audio file to 16kHz mono float32."""
        waveform = _decode_audio(str(file_path), sampling_rate=self.sample_rate)
        return waveform, self.sample_rate

    def _run_segmentation(self, waveform: np.ndarray) -> List[Segment]:
        """Sliding window segmentation with permutation reordering and average confidence stitching."""
        step_samples = int(self.step * self.sample_rate)
        window_samples = int(self.duration * self.sample_rate)

        pad_width = window_samples - (len(waveform) % window_samples)
        if pad_width < window_samples:
            waveform = np.pad(waveform, (0, pad_width), mode="constant")

        num_frames = self.sample2frame(window_samples)
        seconds_per_frame = self.duration / num_frames

        total_duration = len(waveform) / self.sample_rate
        total_frames = int(total_duration / seconds_per_frame) + 100

        global_scores = np.zeros((total_frames, 3), dtype=np.float32)
        overlap_frames = self.sample2frame(window_samples - step_samples)

        for i_sample in range(0, len(waveform) - window_samples + 1, step_samples):
            chunk = waveform[i_sample : i_sample + window_samples]
            chunk = chunk[np.newaxis, np.newaxis, :]

            out = self.segmentation_session.run(None, {"input_values": chunk})[0][0]
            out = np.exp(out)

            # Pyannote 3.0 powerset multi-speaker aggregation
            out[:, 1] += out[:, 4] + out[:, 5]
            out[:, 2] += out[:, 4] + out[:, 6]
            out[:, 3] += out[:, 5] + out[:, 6]
            speech_prob = out[:, 1:4]

            start_frame_global = int((i_sample / self.sample_rate) / seconds_per_frame)
            end_frame_global = start_frame_global + len(speech_prob)

            if i_sample > 0:
                current_slice = global_scores[start_frame_global:end_frame_global]
                overlap_slice = current_slice[:overlap_frames]
                speech_prob = self.reorder(overlap_slice, speech_prob)

                overlap_end = start_frame_global + overlap_frames
                global_scores[start_frame_global:overlap_end] = (
                    overlap_slice + speech_prob[:overlap_frames]
                ) / 2.0
                global_scores[overlap_end:end_frame_global] = speech_prob[overlap_frames:]
            else:
                global_scores[start_frame_global:end_frame_global] = speech_prob

        # Hysteresis thresholding
        is_actives = [False] * 3
        list_segments: List[List[Segment]] = [[], [], []]
        start_ts = [0.0, 0.0, 0.0]
        end_ts = [0.0, 0.0, 0.0]

        for f, scores in enumerate(global_scores):
            t = f * seconds_per_frame
            if t > total_duration:
                break

            for i_speaker in range(3):
                if not is_actives[i_speaker]:
                    if scores[i_speaker] > self.onset:
                        is_actives[i_speaker] = True
                        start_ts[i_speaker] = t
                else:
                    if scores[i_speaker] < self.offset:
                        is_actives[i_speaker] = False
                        end_ts[i_speaker] = t
                        if end_ts[i_speaker] - start_ts[i_speaker] >= self.min_duration_on:
                            list_segments[i_speaker].append(
                                Segment(start_ts[i_speaker], end_ts[i_speaker])
                            )

        for i_speaker in range(3):
            if is_actives[i_speaker]:
                end_ts[i_speaker] = total_duration
                if end_ts[i_speaker] - start_ts[i_speaker] >= self.min_duration_on:
                    list_segments[i_speaker].append(
                        Segment(start_ts[i_speaker], end_ts[i_speaker])
                    )

        segments = []
        for i_speaker in range(3):
            segments.extend(
                list(Timeline(list_segments[i_speaker]).support(collar=self.min_duration_off))
            )

        segments.sort(key=lambda s: s.start)
        return segments

    def _extract_embeddings(
        self, waveform: np.ndarray, segments: List[Segment]
    ) -> Tuple[np.ndarray, List[Segment]]:
        """Extract WeSpeaker 256-D normalized embeddings using 80-mel log mel-spectrogram."""
        embeddings = []
        valid_segments = []

        for segment in segments:
            start_sample = int(segment.start * self.sample_rate)
            end_sample = int(segment.end * self.sample_rate)
            if end_sample > len(waveform):
                end_sample = len(waveform)

            chunk = waveform[start_sample:end_sample]
            if len(chunk) < 400:  # < 25ms
                continue

            n_fft = 400
            hop_length = 160
            n_mels = 80

            melspec = librosa.feature.melspectrogram(
                y=chunk,
                sr=self.sample_rate,
                n_fft=n_fft,
                hop_length=hop_length,
                n_mels=n_mels,
                window="hamming",
                center=False,
            )
            log_melspec = np.log(melspec + 1e-6)
            features = log_melspec.T
            features = features - np.mean(features, axis=0)
            features = features[np.newaxis, :, :]

            try:
                emb = self.embedding_session.run(None, {"input_features": features})[0][0]
                norm = np.linalg.norm(emb)
                if norm > 1e-6:
                    emb = emb / norm
                embeddings.append(emb)
                valid_segments.append(segment)
            except Exception as e:
                logger.warning(f"Embedding extraction error on segment: {e}")

        return np.array(embeddings, dtype=np.float32), valid_segments

    def _cluster_embeddings(
        self,
        embeddings: np.ndarray,
        segments: List[Segment],
        num_speakers: Optional[int] = None,
    ) -> List[int]:
        """Two-stage Pyannote 3.1 clustering: core speaker clustering + nearest-centroid assignment."""
        n_samples = len(embeddings)
        if n_samples == 0:
            return []
        if n_samples == 1:
            return [0]

        duration = sum(s.end - s.start for s in segments)
        min_duration = float(np.clip(duration / 60.0, 2.0, 5.0))

        long_indices = [i for i, s in enumerate(segments) if (s.end - s.start) >= min_duration]
        short_indices = [i for i, s in enumerate(segments) if (s.end - s.start) < min_duration]

        if len(long_indices) < 2 or (num_speakers is not None and num_speakers <= 1):
            if num_speakers and num_speakers > 1:
                ac = AgglomerativeClustering(
                    n_clusters=min(num_speakers, n_samples),
                    metric="euclidean",
                    linkage="ward",
                )
                return ac.fit_predict(embeddings).tolist()
            return [0] * n_samples

        long_embeddings = embeddings[long_indices]

        if num_speakers:
            clustering = AgglomerativeClustering(
                n_clusters=min(num_speakers, len(long_embeddings)),
                metric="euclidean",
                linkage="ward",
            )
        else:
            distance_threshold = max((350.0 - duration) / 350.0, 0.73)
            clustering = AgglomerativeClustering(
                n_clusters=None,
                distance_threshold=distance_threshold,
                metric="euclidean",
                linkage="single",
            )

        clustering.fit(long_embeddings)
        long_labels = clustering.labels_

        labels = np.zeros(n_samples, dtype=int)
        labels[long_indices] = long_labels

        if len(short_indices) > 0:
            unique_labels = np.unique(long_labels)
            centroids = []
            centroid_labels = []

            for label in unique_labels:
                cluster_emb = long_embeddings[long_labels == label]
                centroid = np.mean(cluster_emb, axis=0)
                centroids.append(centroid)
                centroid_labels.append(label)

            centroids = np.array(centroids)
            short_embeddings = embeddings[short_indices]

            dists = cdist(short_embeddings, centroids, metric="euclidean")
            nearest_centroid_indices = np.argmin(dists, axis=1)

            short_labels = [centroid_labels[i] for i in nearest_centroid_indices]
            labels[short_indices] = short_labels

        return labels.tolist()

    def diarize_audio(
        self,
        audio: np.ndarray,
        sr: int = 16000,
        num_speakers: Optional[int] = None,
    ) -> DiarizationResponse:
        """Run Pyannote 3.1 ONNX Extended diarization and return DiarizationResponse."""
        t0 = time.time()
        total_duration = len(audio) / sr

        if self.segmentation_session is None or self.embedding_session is None:
            raise RuntimeError("Pyannote 3.1 ONNX models are not loaded")

        # 1. Sliding window segmentation
        segments = self._run_segmentation(audio)

        if not segments:
            return DiarizationResponse(
                total_duration_seconds=round(total_duration, 3),
                speaker_clusters=[],
                diarized_turns=[],
                processing_time_ms=round((time.time() - t0) * 1000.0, 2),
            )

        # 2. Extract embeddings
        embeddings, valid_segments = self._extract_embeddings(audio, segments)

        if len(embeddings) == 0:
            return DiarizationResponse(
                total_duration_seconds=round(total_duration, 3),
                speaker_clusters=[],
                diarized_turns=[],
                processing_time_ms=round((time.time() - t0) * 1000.0, 2),
            )

        # 3. Two-stage clustering
        labels = self._cluster_embeddings(embeddings, valid_segments, num_speakers=num_speakers)

        # 4. Canonical speaker key assignment
        annotation = Annotation()
        for seg, lbl in zip(valid_segments, labels):
            annotation[seg] = f"SPEAKER_{lbl:02d}"

        merged_annotation = annotation.support()

        label_to_key: Dict[str, str] = {}
        next_speaker_idx = 1
        diarized_turns: List[DiarizedTurn] = []

        for turn, _, raw_speaker in merged_annotation.itertracks(yield_label=True):
            if raw_speaker not in label_to_key:
                label_to_key[raw_speaker] = f"sys:S{next_speaker_idx}"
                next_speaker_idx += 1

            ckey = label_to_key[raw_speaker]
            s_t = round(turn.start, 3)
            e_t = round(turn.end, 3)
            d_t = round(e_t - s_t, 3)

            diarized_turns.append(
                DiarizedTurn(
                    turn_id=len(diarized_turns) + 1,
                    start_time=s_t,
                    end_time=e_t,
                    duration=d_t,
                    cluster_key=ckey,
                    channel="system",
                    confidence=0.95,
                )
            )

        # 5. Build cluster summaries
        cluster_info: Dict[str, Dict[str, Any]] = {}
        for t in diarized_turns:
            c = cluster_info.setdefault(t.cluster_key, {"turns": 0, "total_dur": 0.0})
            c["turns"] += 1
            c["total_dur"] += t.duration

        cluster_summaries: List[ClusterSummary] = []
        for c_key, c_val in sorted(cluster_info.items()):
            num = c_key.replace("sys:S", "")
            cluster_summaries.append(
                ClusterSummary(
                    cluster_key=c_key,
                    channel="system",
                    display_label=f"Speaker {num}",
                    turn_count=c_val["turns"],
                    total_spoken_seconds=round(c_val["total_dur"], 2),
                    centroid_norm=1.0,
                )
            )

        elapsed_ms = (time.time() - t0) * 1000.0

        return DiarizationResponse(
            total_duration_seconds=round(total_duration, 3),
            speaker_clusters=cluster_summaries,
            diarized_turns=diarized_turns,
            processing_time_ms=round(elapsed_ms, 2),
        )

    def to_rttm(self, diarization_resp: DiarizationResponse, uri: str = "audio") -> str:
        lines = []
        for turn in diarization_resp.diarized_turns:
            spk_label = turn.cluster_key.replace("sys:", "").replace("mic:", "")
            line = (
                f"SPEAKER {uri} 1 {turn.start_time:.3f} {turn.duration:.3f} "
                f"<NA> <NA> {spk_label} <NA> <NA>"
            )
            lines.append(line)
        return "\n".join(lines) + "\n" if lines else ""

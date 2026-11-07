"""Local-only audio analysis helper. Invoked by audio-analysis.ts, never a shell parser.

Optional dependencies: numpy, mediapipe (sound events), pyannote.audio>=4
(diarization). Models must be provisioned separately. No model downloads, hub
identifiers, telemetry, or remote Python code are accepted by this adapter.
"""
import contextlib
import json
import math
import os
import socket
import sys
import wave

MAX_SECONDS = 600
MAX_ITEMS = 10000


def deny_network(*_args, **_kwargs):
    raise RuntimeError("audio analysis is local-only; network access is disabled")


# Defense in depth alongside offline hub settings; a missing bundled dependency
# must fail rather than trigger a package/model/telemetry fetch.
socket.socket.connect = deny_network
socket.socket.connect_ex = deny_network
socket.create_connection = deny_network
socket.getaddrinfo = deny_network
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
os.environ["PYANNOTE_METRICS_ENABLED"] = "0"
os.environ["DO_NOT_TRACK"] = "1"


def load_pcm(audio_path):
    import numpy as np
    with wave.open(audio_path, "rb") as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, 16000):
            raise ValueError("input must be mono PCM16 WAV at 16000 Hz; normalize through Kyberion's media runner")
        if audio.getcomptype() != "NONE":
            raise ValueError("compressed WAV is unsupported")
        frames = audio.getnframes()
        if frames < 1 or frames > MAX_SECONDS * 16000:
            raise ValueError("audio duration must be within 0..600 seconds; split longer recordings explicitly")
        pcm = audio.readframes(frames)
        if len(pcm) != frames * 2:
            raise ValueError("truncated WAV data")
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def speaker_intervals(samples, config):
    import torch
    from pyannote.audio import Pipeline
    torch.set_num_threads(2)
    # Config has already been schema-restricted to the built-in SpeakerDiarization
    # class and local checkpoint subfolders by the TS secure-I/O facade.
    pipeline = Pipeline.from_pretrained(config, token=False)
    if pipeline is None:
        raise RuntimeError("local Community-1 bundle could not be loaded; provision config and all model subfolders")
    output = pipeline({"waveform": torch.from_numpy(samples.copy()).unsqueeze(0), "sample_rate": 16000}, max_speakers=20)
    annotation = getattr(output, "speaker_diarization", None)
    if annotation is None:
        raise RuntimeError("pyannote.audio>=4 Community-1 output is required")
    results = []
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        results.append({"start_sec": float(turn.start), "end_sec": float(turn.end), "speaker_id": str(speaker)})
        if len(results) > MAX_ITEMS:
            raise ValueError("diarization exceeded interval budget; no partial result returned")
    return results


def classify_events(samples, model):
    import mediapipe as mp
    options = mp.tasks.audio.AudioClassifierOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=model),
        running_mode=mp.tasks.audio.RunningMode.AUDIO_CLIPS,
        max_results=3,
        score_threshold=0.25,
    )
    events = []
    # Fixed windows avoid sending an entire long recording into a model graph.
    window_samples = 4 * 16000
    with mp.tasks.audio.AudioClassifier.create_from_options(options) as classifier:
        for offset in range(0, len(samples), window_samples):
            block = samples[offset:offset + window_samples]
            block_end = (offset + len(block)) / 16000.0
            audio_data = mp.tasks.components.containers.AudioData.create_from_array(block, 16000)
            classified = classifier.classify(audio_data)
            for index, result in enumerate(classified):
                stamp = getattr(result, "timestamp_ms", None)
                if stamp is None or not math.isfinite(stamp) or stamp < 0:
                    raise ValueError("audio classifier returned no valid timestamp")
                start = offset / 16000.0 + stamp / 1000.0
                if start >= block_end:
                    continue  # Some models classify a final padded window.
                next_ms = getattr(classified[index + 1], "timestamp_ms", None) if index + 1 < len(classified) else None
                end = min(block_end, offset / 16000.0 + next_ms / 1000.0) if next_ms is not None else min(block_end, start + 0.975)
                if end <= start:
                    raise ValueError("audio classifier returned non-increasing timestamps")
                for head in result.classifications:
                    for category in head.categories:
                        label = category.category_name or category.display_name
                        if not label:
                            raise ValueError("YAMNet asset must include category label metadata")
                        events.append({"start_sec": start, "end_sec": end, "label": label, "confidence": float(category.score)})
                        if len(events) > MAX_ITEMS:
                            raise ValueError("sound events exceeded interval budget; no partial result returned")
    return events


def main():
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError("request exceeds 64 KiB")
    request = json.loads(raw)
    with contextlib.redirect_stdout(sys.stderr):
        samples = load_pcm(request["audio"])
        speakers = speaker_intervals(samples, request["diarization_config"]) if request.get("diarization_config") else []
        events = classify_events(samples, request["audio_model"]) if request.get("audio_model") else []
    providers = []
    if request.get("diarization_config"):
        providers.append("pyannote-community-1")
    if request.get("audio_model"):
        providers.append("mediapipe-audio-classifier")
    if not providers:
        raise ValueError("no audio analysis selected")
    warnings = ["Diarization labels are anonymous and tentative; they do not identify a person."] if speakers else []
    if request.get("audio_model"):
        warnings.append("Sound-event intervals are classification windows, not exact event onset/offset boundaries.")
    print(json.dumps({"provider": "+".join(providers), "speakers": speakers, "events": events, "warnings": warnings}, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except ModuleNotFoundError as failure:
        print("[AUDIO_DEPENDENCY_MISSING] Install the selected adapter's optional numpy, mediapipe, or pyannote.audio>=4 dependency in the configured Python environment: " + str(failure), file=sys.stderr)
        sys.exit(1)
    except Exception as failure:
        print("[AUDIO_ANALYSIS_FAILED] " + str(failure), file=sys.stderr)
        sys.exit(1)

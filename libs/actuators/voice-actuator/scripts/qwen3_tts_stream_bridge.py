#!/usr/bin/env python3
"""Qwen3-TTS 0.6B streaming bridge for Kyberion's shell PCM TTS seam.

Streaming mode (`--stream`): newline-delimited UTF-8 text on stdin; raw mono
PCM_S16LE at 16 kHz on stdout by default. `--output-sample-rate` may select a
device-supported rate for direct CoreAudio playback. Default mode accepts the
JSON health/generate bridge protocol. Diagnostics go to stderr. The 8-bit model
must already exist in the managed Hugging Face cache; this bridge never
downloads it implicitly.
"""

from __future__ import annotations

import contextlib
import gc
import os
import sys
from math import gcd
from pathlib import Path
from typing import Any

import numpy as np
from scipy.signal import resample_poly

MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"
SPEAKER = "Ono_Anna"
LANGUAGE = "Japanese"
STREAMING_INTERVAL_SECONDS = 0.32
MAX_SEGMENT_CHARS = 800
INPUT_SAMPLE_RATE_HZ = 24_000
DEFAULT_OUTPUT_SAMPLE_RATE_HZ = 16_000
MLX_MEMORY_LIMIT_BYTES = 3 * 1024 * 1024 * 1024
MLX_CACHE_LIMIT_BYTES = 256 * 1024 * 1024


def log(message: str) -> None:
    print(f"[qwen3-tts-stream] {message}", file=sys.stderr, flush=True)


def load_local_model() -> tuple[Any, Any]:
    managed_hf_home = (
        Path(__file__).resolve().parents[4]
        / "active/shared/cache/system/tool-runtimes/mlx-audio/huggingface"
    )
    os.environ.setdefault("HF_HOME", str(managed_hf_home))
    try:
        import mlx.core as mx
        from huggingface_hub import snapshot_download
        from mlx_audio.tts.utils import load_model
    except ImportError as exc:
        raise RuntimeError(
            "mlx-audio runtime is unavailable; install it with the governed voice setup"
        ) from exc

    # Bound MLX allocations before model loading. Chunked output avoids retaining
    # a full utterance; these limits also constrain allocator caches.
    set_memory_limit = getattr(mx, "set_memory_limit", None)
    set_cache_limit = getattr(mx, "set_cache_limit", None)
    if not callable(set_memory_limit) or not callable(set_cache_limit):
        raise RuntimeError("installed MLX lacks memory/cache limit controls")
    set_memory_limit(MLX_MEMORY_LIMIT_BYTES)
    set_cache_limit(MLX_CACHE_LIMIT_BYTES)

    try:
        model_path = snapshot_download(repo_id=MODEL_ID, local_files_only=True)
    except Exception as exc:
        raise RuntimeError(
            f"model is not present in the local Hugging Face cache: {MODEL_ID}; "
            "download it explicitly after checking available disk space"
        ) from exc

    # Keep third-party progress output off stdout: stdout is a binary PCM stream.
    with contextlib.redirect_stdout(sys.stderr):
        model = load_model(model_path)
    return model, mx


def emit_segment(model: Any, mx: Any, text: str, pcm_out: Any, output_sample_rate_hz: int) -> None:
    with contextlib.redirect_stdout(sys.stderr):
        results = model.generate_custom_voice(
            text,
            speaker=SPEAKER,
            language=LANGUAGE,
            stream=True,
            streaming_interval=STREAMING_INTERVAL_SECONDS,
        )
        for result in results:
            audio = np.asarray(result.audio, dtype=np.float32).reshape(-1)
            if audio.size == 0:
                continue
            # Qwen3-TTS emits 24 kHz audio. Convert to the negotiated output rate
            # (16 kHz for the generic shell bridge, or a device rate for direct playback).
            ratio = gcd(INPUT_SAMPLE_RATE_HZ, output_sample_rate_hz)
            audio_resampled = resample_poly(
                audio, up=output_sample_rate_hz // ratio, down=INPUT_SAMPLE_RATE_HZ // ratio
            )
            pcm = np.rint(np.clip(audio_resampled, -1.0, 1.0) * 32767.0).astype("<i2")
            pcm_out.write(pcm.tobytes())
            pcm_out.flush()
            del result, audio, audio_resampled, pcm
    clear_cache = getattr(mx, "clear_cache", None)
    if callable(clear_cache):
        clear_cache()
    gc.collect()


def generate_artifact(model: Any, text: str, output_path: str) -> dict[str, Any]:
    from pathlib import Path
    from mlx_audio.sts import save_audio

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    results = model.generate_custom_voice(text, speaker=SPEAKER, language=LANGUAGE)
    last = None
    with contextlib.redirect_stdout(sys.stderr):
        for result in results:
            last = result
    if last is None:
        raise RuntimeError("model returned no audio")
    save_audio(last.audio, str(out), sample_rate=INPUT_SAMPLE_RATE_HZ)
    return {"status": "success", "output_path": str(out), "model": MODEL_ID, "speaker": SPEAKER}


def main() -> int:
    if "--stream" in sys.argv[1:]:
        return run_stream()
    return run_json()


def run_stream() -> int:
    pcm_out = sys.stdout.buffer
    model = None
    mx = None
    output_sample_rate_hz = DEFAULT_OUTPUT_SAMPLE_RATE_HZ
    if "--output-sample-rate" in sys.argv:
        index = sys.argv.index("--output-sample-rate")
        try:
            output_sample_rate_hz = int(sys.argv[index + 1])
        except (IndexError, ValueError) as exc:
            log("--output-sample-rate requires an integer value")
            return 2
        if output_sample_rate_hz not in {16_000, 24_000, 44_100, 48_000}:
            log("--output-sample-rate must be one of 16000, 24000, 44100, or 48000")
            return 2
    try:
        for raw_line in sys.stdin.buffer:
            try:
                text = raw_line.decode("utf-8").strip()
            except UnicodeDecodeError as exc:
                raise RuntimeError("stdin text must be UTF-8") from exc
            if not text:
                continue
            if len(text) > MAX_SEGMENT_CHARS:
                raise RuntimeError(
                    f"text segment exceeds the {MAX_SEGMENT_CHARS}-character safety limit"
                )
            if model is None:
                model, mx = load_local_model()
            emit_segment(model, mx, text, pcm_out, output_sample_rate_hz)
        return 0
    except BrokenPipeError:
        return 0
    except Exception as exc:
        log(str(exc))
        return 1


def run_json() -> int:
    import json
    from json_boundary import JsonInputError, parse_json_object

    raw = sys.stdin.read().strip()
    if not raw:
        print(json.dumps({"status": "error", "error": "No input on stdin"}))
        return 1
    try:
        payload = parse_json_object(raw, "Qwen3-TTS 0.6B input")
        action = payload.get("action")
        params = payload.get("params") or {}
        if action == "health":
            try:
                import mlx_audio  # noqa: F401
                result = {"status": "ok", "model": MODEL_ID, "streaming": True}
            except ImportError:
                result = {
                    "status": "unavailable",
                    "error": "mlx_audio not installed",
                    "install_hint": "pnpm kyberion voice setup --tool mlx_audio --apply",
                }
        elif action == "generate":
            text = str(params.get("text") or "").strip()
            output_path = str(params.get("output_path") or "").strip()
            if not text or not output_path:
                result = {"status": "error", "error": "params.text and params.output_path are required"}
            elif len(text) > MAX_SEGMENT_CHARS:
                result = {"status": "error", "error": f"text exceeds {MAX_SEGMENT_CHARS}-character limit"}
            else:
                model, _mx = load_local_model()
                result = generate_artifact(model, text, output_path)
        else:
            result = {"status": "error", "error": f"Unknown action: {action!r}"}
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("status") in ("ok", "success", "unavailable") else 1
    except JsonInputError as exc:
        print(json.dumps({"status": "error", "error": f"Invalid JSON: {exc}"}))
        return 1
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

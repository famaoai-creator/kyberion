#!/usr/bin/env python3
"""Low-latency MLX Whisper adapter for Kyberion streaming STT.

Contract:
  - read raw PCM_S16LE mono audio at 16 kHz from stdin
  - emit one NDJSON final transcript per short audio window on stdout

The Python process and MLX model stay resident for one utterance. This avoids
the per-turn process/model startup used by the batch bridge while the VAD
recorder is still receiving microphone audio.
"""

import json
import os
import sys

import numpy as np

SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2


def emit(text: str, index: int) -> None:
    cleaned = text.strip()
    if not cleaned:
        return
    sys.stdout.write(
        json.dumps(
            {
                "utterance_id": f"mlx-window-{index}",
                "is_final": True,
                "text": cleaned,
                "confidence": 0.0,
            },
            ensure_ascii=False,
        )
        + "\n"
    )
    sys.stdout.flush()


def transcribe(audio: np.ndarray, model_id: str, language: str) -> str:
    import mlx_whisper

    result = mlx_whisper.transcribe(
        audio,
        path_or_hf_repo=model_id,
        language=language,
        verbose=False,
        temperature=0.0,
        condition_on_previous_text=False,
    )
    return str(result.get("text") or "")


def main() -> int:
    try:
        import mlx_whisper  # noqa: F401
    except Exception as exc:
        sys.stderr.write(f"[stt] mlx_whisper import failed: {exc}\n")
        return 1

    model_id = os.environ.get(
        "KYBERION_MLX_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo"
    )
    language = os.environ.get("KYBERION_STT_LANGUAGE", "ja")
    try:
        window_sec = max(0.8, float(os.environ.get("KYBERION_STT_WINDOW_SEC", "1.5")))
    except ValueError:
        window_sec = 1.5
    window_bytes = int(SAMPLE_RATE * BYTES_PER_SAMPLE * window_sec)

    sys.stderr.write(
        f"[stt] managed mlx_whisper ready model={model_id} lang={language} window={window_sec}s\n"
    )
    sys.stderr.flush()

    buffer = bytearray()
    window_index = 0
    stdin = sys.stdin.buffer
    while True:
        chunk = stdin.read(4096)
        if not chunk:
            break
        buffer.extend(chunk)
        while len(buffer) >= window_bytes:
            raw = bytes(buffer[:window_bytes])
            del buffer[:window_bytes]
            audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            try:
                emit(transcribe(audio, model_id, language), window_index)
            except Exception as exc:
                sys.stderr.write(f"[stt] transcribe error: {exc}\n")
                sys.stderr.flush()
            window_index += 1

    if len(buffer) >= int(SAMPLE_RATE * BYTES_PER_SAMPLE * 0.25):
        usable = len(buffer) - (len(buffer) % BYTES_PER_SAMPLE)
        audio = np.frombuffer(bytes(buffer[:usable]), dtype=np.int16).astype(np.float32) / 32768.0
        try:
            emit(transcribe(audio, model_id, language), window_index)
        except Exception as exc:
            sys.stderr.write(f"[stt] final transcribe error: {exc}\n")
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""
Streaming STT wrapper for KYBERION_STT_COMMAND (faster-whisper backend).

Contract (per meeting-participation-runtime / meeting-environment-policy):
  - reads raw PCM_S16LE mono @ 16 kHz on stdin
  - emits one NDJSON transcript chunk per line on stdout: {"text","start","end","final"}

Env:
  KYBERION_STT_MODEL       model size or local path (default: "small")
  KYBERION_STT_MODEL_DIR   local CTranslate2 model dir (overrides model id; use when
                           huggingface.co is egress-blocked — download the model on an
                           unblocked host, e.g. Systran/faster-whisper-small, and point here)
  KYBERION_STT_LANGUAGE    language code (default: "ja")
  KYBERION_STT_WINDOW_SEC  seconds of audio per transcription window (default: 5)
  SSL_CERT_FILE            CA bundle (set to the Zscaler root when downloading a model)

Usage (as KYBERION_STT_COMMAND):
  KYBERION_STT_COMMAND=active/shared/runtime/tool-runtimes/faster-whisper/bin/python
  KYBERION_STT_ARGS=scripts/stt_faster_whisper_stream.py
"""
import json
import os
import sys

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2  # s16le


def main() -> int:
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # pragma: no cover
        sys.stderr.write(f"[stt] faster-whisper import failed: {exc}\n")
        return 1

    model_ref = os.environ.get("KYBERION_STT_MODEL_DIR") or os.environ.get(
        "KYBERION_STT_MODEL", "small"
    )
    language = os.environ.get("KYBERION_STT_LANGUAGE", "ja")
    window_sec = float(os.environ.get("KYBERION_STT_WINDOW_SEC", "5"))
    window_bytes = int(SAMPLE_RATE * BYTES_PER_SAMPLE * window_sec)

    try:
        model = WhisperModel(model_ref, device="cpu", compute_type="int8")
    except Exception as exc:
        sys.stderr.write(
            f"[stt] model load failed for '{model_ref}': {exc}\n"
            "[stt] If huggingface.co is blocked, set KYBERION_STT_MODEL_DIR to a local "
            "CTranslate2 model directory.\n"
        )
        return 1

    sys.stderr.write(f"[stt] ready model={model_ref} lang={language} window={window_sec}s\n")
    sys.stderr.flush()

    import numpy as np

    elapsed = 0.0
    buf = bytearray()
    stdin = sys.stdin.buffer
    while True:
        chunk = stdin.read(window_bytes - len(buf))
        if not chunk:
            break
        buf.extend(chunk)
        if len(buf) < window_bytes:
            continue
        audio = np.frombuffer(bytes(buf), dtype=np.int16).astype(np.float32) / 32768.0
        buf.clear()
        try:
            segments, _ = model.transcribe(audio, language=language, vad_filter=True)
            for s in segments:
                text = s.text.strip()
                if not text:
                    continue
                sys.stdout.write(
                    json.dumps(
                        {
                            "text": text,
                            "start": round(elapsed + s.start, 2),
                            "end": round(elapsed + s.end, 2),
                            "final": True,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                sys.stdout.flush()
        except Exception as exc:  # pragma: no cover
            sys.stderr.write(f"[stt] transcribe error: {exc}\n")
            sys.stderr.flush()
        elapsed += window_sec
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

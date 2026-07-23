#!/usr/bin/env python3
"""Silero VAD bridge — NDJSON stdio protocol for libs/core/silero-vad-bridge.ts.

Input lines:
  {"pcm": "<base64 s16le mono>", "sr": 16000}   -> {"prob": 0.87}
  {"reset": true}                                -> {"ok": true}

Requires onnxruntime + numpy and a current silero_vad ONNX model (v6.2 and
backward-compatible v4/v5 layouts with
LSTM state passed between calls). The model path comes from --model or
KYBERION_SILERO_VAD_MODEL. On any fatal error a single {"error": ...} line is
emitted and the process exits non-zero; the TypeScript side then degrades to
the energy VAD.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys

WINDOW = 512  # silero v5 expects 512-sample windows at 16 kHz


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def fatal(message: str) -> None:
    emit({"error": message})
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=os.environ.get("KYBERION_SILERO_VAD_MODEL", ""))
    args = parser.parse_args()

    if not args.model or not os.path.exists(args.model):
        fatal(f"silero model not found: {args.model!r} (set KYBERION_SILERO_VAD_MODEL)")

    try:
        import numpy as np  # type: ignore
        import onnxruntime as ort  # type: ignore
    except Exception as exc:  # pragma: no cover - import guard
        fatal(f"onnxruntime/numpy unavailable: {exc}")
        return

    try:
        session = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    except Exception as exc:
        fatal(f"failed to load model: {exc}")
        return

    input_names = {i.name for i in session.get_inputs()}
    # v5 models take a single combined "state"; v4 models take h/c separately.
    v5 = "state" in input_names

    def fresh_state():
        if v5:
            return {"state": np.zeros((2, 1, 128), dtype=np.float32)}
        return {
            "h": np.zeros((2, 1, 64), dtype=np.float32),
            "c": np.zeros((2, 1, 64), dtype=np.float32),
        }

    state = fresh_state()
    residual = np.zeros(0, dtype=np.float32)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue

        if request.get("reset"):
            state = fresh_state()
            residual = np.zeros(0, dtype=np.float32)
            emit({"ok": True})
            continue

        pcm_b64 = request.get("pcm")
        if not isinstance(pcm_b64, str):
            continue
        sr = int(request.get("sr", 16000))
        try:
            raw = base64.b64decode(pcm_b64)
        except Exception:
            continue
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        residual = np.concatenate([residual, samples])

        prob = 0.0
        try:
            while residual.shape[0] >= WINDOW:
                window = residual[:WINDOW]
                residual = residual[WINDOW:]
                feeds = {
                    "input": window.reshape(1, -1),
                    "sr": np.array(sr, dtype=np.int64),
                    **state,
                }
                outputs = session.run(None, feeds)
                prob = max(prob, float(outputs[0].reshape(-1)[0]))
                if v5:
                    state = {"state": outputs[1]}
                else:
                    state = {"h": outputs[1], "c": outputs[2]}
        except Exception as exc:
            fatal(f"inference failed: {exc}")
            return
        emit({"prob": prob})


if __name__ == "__main__":
    main()

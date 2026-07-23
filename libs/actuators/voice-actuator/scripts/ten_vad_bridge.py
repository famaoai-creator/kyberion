#!/usr/bin/env python3
"""TEN VAD NDJSON bridge for Kyberion's synchronous VAD interface."""

from __future__ import annotations

import argparse
import base64
import json
import sys


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hop-size", type=int, default=160, choices=(160, 256))
    parser.add_argument("--threshold", type=float, default=0.5)
    args = parser.parse_args()

    try:
        import numpy as np
        from ten_vad import TenVad
    except Exception as exc:
        emit({"error": f"TEN VAD unavailable: {exc}"})
        raise SystemExit(1)

    vad = TenVad(args.hop_size, float(args.threshold))
    residual = np.zeros(0, dtype=np.int16)

    def probability(result) -> float:
        for name in ("probability", "prob", "score"):
            value = getattr(result, name, None)
            if value is not None:
                return float(value() if callable(value) else value)
        for name in ("get_probability", "getProbability"):
            method = getattr(result, name, None)
            if callable(method):
                return float(method())
        if isinstance(result, (tuple, list)) and result:
            return float(result[0])
        raise TypeError(f"unsupported TEN VAD result: {type(result)!r}")

    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        if request.get("reset"):
            destroy = getattr(vad, "destroy", None)
            if callable(destroy):
                destroy()
            vad = TenVad(args.hop_size, float(args.threshold))
            residual = np.zeros(0, dtype=np.int16)
            emit({"ok": True})
            continue

        encoded = request.get("pcm")
        if not isinstance(encoded, str):
            continue
        try:
            samples = np.frombuffer(base64.b64decode(encoded), dtype=np.int16)
            residual = np.concatenate((residual, samples))
            prob = 0.0
            while residual.size >= args.hop_size:
                frame = residual[: args.hop_size]
                residual = residual[args.hop_size :]
                result = vad.process(frame)
                prob = max(prob, probability(result))
            emit({"prob": prob})
        except Exception as exc:
            emit({"error": f"TEN VAD inference failed: {exc}"})
            raise SystemExit(1)


if __name__ == "__main__":
    main()

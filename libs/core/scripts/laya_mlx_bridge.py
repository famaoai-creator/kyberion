"""Laya-MLX judgment worker.

Laya answers typed questions in one bidirectional encoder pass — no token
generation — so a judgment costs ~24 ms once the checkpoint is resident.
Loading it costs seconds, which is why this is a resident worker rather
than a `laya-mlx predict` call per judgment.

Protocol (NDJSON over stdio, one JSON object per line):
  <- {"ready": true, "model": "..."}            on startup, after load
  -> {"state": "...", "questions": {...}}
  <- {"answers": {...}, "usage": {...}}
  <- {"error": "..."}                           per-request; worker stays up

`questions` and `answers` are passed through untouched, so the TypeScript
side owns the question shapes and this file does not need to change when
they do.
"""

import json
import os
import sys


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    model = os.environ.get("KYBERION_LAYA_MODEL", "aac6fef/laya-multilingual-mlx")
    dtype = os.environ.get("KYBERION_LAYA_DTYPE", "float16")

    try:
        import laya_mlx as laya
    except Exception as error:  # noqa: BLE001 - reported to the parent, not raised
        _emit({"error": f"laya_mlx import failed: {error}"})
        return 1

    try:
        agent = laya.load(model, dtype=dtype)
    except Exception as error:  # noqa: BLE001
        _emit({"error": f"laya_mlx load failed for '{model}': {error}"})
        return 1

    _emit({"ready": True, "model": model})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            _emit({"error": f"malformed request: {error}"})
            continue

        state = request.get("state")
        questions = request.get("questions")
        if not isinstance(questions, dict) or not questions:
            _emit({"error": "request needs a non-empty 'questions' object"})
            continue

        try:
            result = agent.predict(state, questions)
        except Exception as error:  # noqa: BLE001 - one bad request must not kill the worker
            _emit({"error": f"predict failed: {error}"})
            continue

        _emit({"answers": result.get("answers", {}), "usage": result.get("usage", {})})

    return 0


if __name__ == "__main__":
    sys.exit(main())

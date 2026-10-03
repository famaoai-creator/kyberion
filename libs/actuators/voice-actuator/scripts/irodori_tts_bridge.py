#!/usr/bin/env python3
"""Governed mlx-audio bridge for Irodori-TTS v4.1 Small."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from json_boundary import JsonInputError, parse_json_object

DEFAULT_MODEL = "mlx-community/Irodori-TTS-v4.1-Small-8bit"
DEFAULT_NUM_STEPS = 8


def _resolve_generated_output(out: Path) -> Path | None:
    if out.is_file():
        return out
    suffix = out.suffix or ".wav"
    candidates = [
        path
        for pattern in (f"{out.stem}{suffix}", f"{out.stem}_*{suffix}", f"{out.stem}-*{suffix}")
        for path in out.parent.glob(pattern)
        if path.is_file()
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda path: (path.stat().st_mtime, path.stat().st_size), reverse=True)
    candidates[0].replace(out)
    return out


def _health() -> dict:
    try:
        import mlx_audio  # noqa: F401
        return {"status": "ok", "model": DEFAULT_MODEL, "num_steps": DEFAULT_NUM_STEPS}
    except ImportError:
        return {"status": "unavailable", "error": "mlx_audio not installed"}


def _generate(params: dict) -> dict:
    text = str(params.get("text") or "").strip()
    output_path = str(params.get("output_path") or "").strip()
    if not text:
        return {"status": "error", "error": "params.text is required"}
    if not output_path:
        return {"status": "error", "error": "params.output_path is required"}

    try:
        num_steps = int(params.get("num_steps", DEFAULT_NUM_STEPS))
    except (TypeError, ValueError):
        return {"status": "error", "error": "params.num_steps must be an integer"}
    if not 1 <= num_steps <= 40:
        return {"status": "error", "error": "params.num_steps must be between 1 and 40"}

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        from mlx_audio.tts.generate import generate_audio

        generate_audio(
            text=text,
            model=DEFAULT_MODEL,
            lang_code="ja",
            output_path=str(out.parent),
            file_prefix=out.stem,
            audio_format="wav",
            save=True,
            play=False,
            verbose=False,
            num_steps=num_steps,
        )
    except Exception as exc:
        return {"status": "error", "error": str(exc)}

    if not _resolve_generated_output(out):
        return {"status": "error", "error": f"Output file was not created: {out}"}
    return {
        "status": "success",
        "output_path": str(out),
        "model": DEFAULT_MODEL,
        "num_steps": num_steps,
    }


def main() -> None:
    raw = sys.stdin.read().strip()
    if not raw:
        print(json.dumps({"status": "error", "error": "No input on stdin"}))
        sys.exit(1)
    try:
        payload = parse_json_object(raw, "Irodori TTS input")
    except JsonInputError as exc:
        print(json.dumps({"status": "error", "error": f"Invalid JSON: {exc}"}))
        sys.exit(1)

    action = payload.get("action")
    params = payload.get("params") or {}
    if action == "health":
        result = _health()
    elif action == "generate":
        result = _generate(params)
    else:
        result = {"status": "error", "error": f"Unknown action: {action!r}"}
    print(json.dumps(result))


if __name__ == "__main__":
    main()

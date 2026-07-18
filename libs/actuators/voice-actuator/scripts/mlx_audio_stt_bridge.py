"""
Kyberion mlx-audio STT Bridge — mlx-whisper transcription.

Usage (stdin JSON):
  echo '{"action":"transcribe","params":{"audio_path":"sample.wav"}}' | python3 mlx_audio_stt_bridge.py

Supported actions:
  transcribe  — transcribe a local audio file
  health      — check mlx_whisper installation
"""

import sys
import json
import os
from pathlib import Path


DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"


def _project_root() -> Path:
    return Path(os.environ.get("KYBERION_PROJECT_ROOT") or Path.cwd()).resolve()


def _guard_audio_path(raw_path: str) -> Path:
    resolved = Path(raw_path).expanduser().resolve()
    root = _project_root()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError("audio_path must stay inside the Kyberion project root") from exc
    return resolved


def _check_health() -> dict:
    try:
        import mlx_whisper  # noqa: F401
        return {"status": "ok", "model": DEFAULT_MODEL}
    except ImportError:
        return {
            "status": "unavailable",
            "error": "mlx_whisper not installed",
            "install_hint": "pnpm voice:setup --apply",
        }


def _transcribe(params: dict) -> dict:
    raw_audio_path = str(params.get("audio_path") or "").strip()
    if not raw_audio_path:
        return {"status": "error", "error": "params.audio_path is required"}

    try:
        audio_file = _guard_audio_path(raw_audio_path)
    except ValueError as exc:
        return {"status": "error", "error": str(exc)}

    if not audio_file.exists():
        return {"status": "error", "error": f"Audio file not found: {audio_file}"}

    model_id = str(params.get("model") or DEFAULT_MODEL).strip()
    language = str(params.get("language") or "").strip() or None

    try:
        import mlx_whisper
    except ImportError:
        return {
            "status": "error",
            "error": "mlx_whisper not installed — run: pnpm voice:setup --apply",
            "install_hint": "pnpm voice:setup --apply",
        }

    try:
        kwargs: dict = {"path_or_hf_repo": model_id}
        if language:
            kwargs["language"] = language

        result = mlx_whisper.transcribe(str(audio_file), **kwargs)
    except Exception as exc:
        return {"status": "error", "error": str(exc)}

    text = (result.get("text") or "").strip()
    detected_lang = result.get("language") or language or "auto"
    segments = []
    for segment in result.get("segments") or []:
        segment_text = str(segment.get("text") or "").strip()
        if not segment_text:
            continue
        segments.append({
            "start_sec": float(segment.get("start") or 0.0),
            "end_sec": float(segment.get("end") or 0.0),
            "text": segment_text,
        })

    return {
        "status": "success",
        "text": text,
        "model": model_id,
        "language": detected_lang,
        "audio_path": str(audio_file),
        "capabilities": {
            "timestamps": bool(segments),
            "granularity": "segment" if segments else "none",
        },
        "segments": segments,
    }


def main() -> None:
    raw = sys.stdin.read().strip()
    if not raw:
        print(json.dumps({"status": "error", "error": "No input on stdin"}))
        sys.exit(1)

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(json.dumps({"status": "error", "error": f"Invalid JSON: {exc}"}))
        sys.exit(1)

    action = payload.get("action")
    params = payload.get("params") or {}

    if action == "health":
        result = _check_health()
    elif action == "transcribe":
        result = _transcribe(params)
    else:
        result = {"status": "error", "error": f"Unknown action: {action!r}"}

    print(json.dumps(result))


if __name__ == "__main__":
    main()

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
from pathlib import Path


DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"


def _check_health() -> dict:
    try:
        import mlx_whisper  # noqa: F401
        return {"status": "ok", "model": DEFAULT_MODEL}
    except ImportError:
        return {
            "status": "unavailable",
            "error": "mlx_whisper not installed",
            "install_hint": "pip install mlx-whisper",
        }


def _transcribe(params: dict) -> dict:
    audio_path = str(params.get("audio_path") or "").strip()
    if not audio_path:
        return {"status": "error", "error": "params.audio_path is required"}

    if not Path(audio_path).exists():
        return {"status": "error", "error": f"Audio file not found: {audio_path}"}

    model_id = str(params.get("model") or DEFAULT_MODEL).strip()
    language = str(params.get("language") or "").strip() or None

    try:
        import mlx_whisper
    except ImportError:
        return {
            "status": "error",
            "error": "mlx_whisper not installed — run: pip install mlx-whisper",
            "install_hint": "pip install mlx-whisper",
        }

    try:
        kwargs: dict = {"path_or_hf_repo": model_id}
        if language:
            kwargs["language"] = language

        result = mlx_whisper.transcribe(audio_path, **kwargs)
    except Exception as exc:
        return {"status": "error", "error": str(exc)}

    text = (result.get("text") or "").strip()
    detected_lang = result.get("language") or language or "auto"

    return {
        "status": "success",
        "text": text,
        "model": model_id,
        "language": detected_lang,
        "audio_path": audio_path,
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

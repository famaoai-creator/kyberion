"""
Kyberion mlx-audio TTS Bridge — Qwen3-TTS via ICL voice cloning.

Usage (stdin JSON):
  echo '{"action":"generate","params":{...}}' | python3 mlx_audio_tts_bridge.py

Supported actions:
  generate   — TTS or voice-clone generation
  health     — check mlx_audio installation
"""

import sys
import json
import os
from pathlib import Path


DEFAULT_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit"


def _check_health() -> dict:
    try:
        import mlx_audio  # noqa: F401
        return {"status": "ok", "model": DEFAULT_MODEL}
    except ImportError:
        return {
            "status": "unavailable",
            "error": "mlx_audio not installed",
            "install_hint": "pip install mlx-audio",
        }


def _generate(params: dict) -> dict:
    text = str(params.get("text") or "").strip()
    if not text:
        return {"status": "error", "error": "params.text is required"}

    output_path = str(params.get("output_path") or "").strip()
    if not output_path:
        return {"status": "error", "error": "params.output_path is required"}

    ref_audio = str(params.get("ref_audio") or "").strip() or None
    ref_text = str(params.get("ref_text") or "").strip() or None
    model_id = str(params.get("model") or DEFAULT_MODEL).strip()
    verbose = bool(params.get("verbose", False))

    try:
        from mlx_audio.tts.generate import generate_audio
    except ImportError:
        return {
            "status": "error",
            "error": "mlx_audio not installed — run: pip install mlx-audio",
            "install_hint": "pip install mlx-audio",
        }

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    # generate_audio writes to: {output_dir}/{file_prefix}.{audio_format}
    output_dir = str(out.parent)
    file_prefix = out.stem

    try:
        kwargs: dict = {
            "text": text,
            "model": model_id,
            "output_path": output_dir,
            "file_prefix": file_prefix,
            "audio_format": "wav",
            "save": True,
            "play": False,
            "verbose": verbose,
        }
        if ref_audio:
            kwargs["ref_audio"] = ref_audio
        if ref_text:
            # Provide transcript so mlx_audio skips the built-in STT model download
            kwargs["ref_text"] = ref_text
            kwargs["stt_model"] = None

        generate_audio(**kwargs)
    except Exception as exc:
        return {"status": "error", "error": str(exc)}

    if not out.exists():
        return {"status": "error", "error": f"Output file was not created: {out}"}

    mode = "voice_clone" if ref_audio else "tts"
    return {
        "status": "success",
        "output_path": str(out),
        "model": model_id,
        "mode": mode,
        "ref_audio": ref_audio,
        "ref_text": ref_text,
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
    elif action == "generate":
        result = _generate(params)
    else:
        result = {"status": "error", "error": f"Unknown action: {action!r}"}

    print(json.dumps(result))


if __name__ == "__main__":
    main()

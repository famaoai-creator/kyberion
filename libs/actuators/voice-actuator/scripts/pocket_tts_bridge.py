#!/usr/bin/env python3
"""Kyberion bridge for Kyutai Pocket TTS.

The process is intentionally one-shot and JSON based so the existing governed
voice actuator can select Pocket TTS without embedding a Python dependency in
the TypeScript runtime. The model and voice state are cached for the lifetime
of this process, which is used by the warm voice actuator path.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_MODEL = None
_VOICE_CACHE: dict[str, object] = {}


def _health() -> dict:
    try:
        import pocket_tts  # noqa: F401
        import scipy  # noqa: F401
    except ImportError as exc:
        return {
            "status": "unavailable",
            "error": str(exc),
            "install_hint": "pnpm voice:setup --apply",
        }
    return {"status": "ok", "model": "kyutai/pocket-tts"}


def _model():
    global _MODEL
    if _MODEL is None:
        from pocket_tts import TTSModel

        _MODEL = TTSModel.load_model()
    return _MODEL


def _voice_state(model, voice: str):
    if voice not in _VOICE_CACHE:
        _VOICE_CACHE[voice] = model.get_state_for_audio_prompt(voice)
    return _VOICE_CACHE[voice]


def _generate(params: dict) -> dict:
    text = str(params.get("text") or "").strip()
    output_path = str(params.get("output_path") or "").strip()
    if not text:
        return {"status": "error", "error": "params.text is required"}
    if not output_path:
        return {"status": "error", "error": "params.output_path is required"}
    if str(params.get("lang_code") or "en").lower().startswith("ja"):
        return {
            "status": "error",
            "error": "Pocket TTS upstream language packs do not currently include Japanese; use Kokoro or Apple Speech for ja.",
        }

    try:
        import scipy.io.wavfile

        model = _model()
        voice = str(params.get("voice") or "alba").strip()
        ref_audio = str(params.get("ref_audio") or "").strip()
        voice_source = ref_audio or voice
        state = _voice_state(model, voice_source)
        audio = model.generate_audio(state, text)
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        scipy.io.wavfile.write(str(out), model.sample_rate, audio.numpy())
        return {
            "status": "success",
            "output_path": str(out),
            "model": "kyutai/pocket-tts",
            "mode": "voice_clone" if ref_audio else "tts",
            "voice": voice_source,
        }
    except Exception as exc:  # pragma: no cover - depends on optional runtime
        return {"status": "error", "error": str(exc)}


def main() -> None:
    raw = sys.stdin.read().strip()
    if not raw:
        print(json.dumps({"status": "error", "error": "No input on stdin"}))
        raise SystemExit(1)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(json.dumps({"status": "error", "error": f"Invalid JSON: {exc}"}))
        raise SystemExit(1)

    action = payload.get("action")
    result = _health() if action == "health" else _generate(payload.get("params") or {}) if action == "generate" else {
        "status": "error",
        "error": f"Unknown action: {action!r}",
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()

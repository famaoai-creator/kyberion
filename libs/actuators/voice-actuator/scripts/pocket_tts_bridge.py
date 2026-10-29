#!/usr/bin/env python3
"""Kyberion bridge for Kyutai Pocket TTS.

The process renders one WAV per JSON invocation so the governed voice actuator
can select Pocket TTS without embedding Python in the TypeScript runtime.
Module-level caches support repeated in-process calls; this bridge does not
create a resident worker or expose a PCM streaming protocol.
"""

from __future__ import annotations

import json
import sys
from collections import OrderedDict
from pathlib import Path
from json_boundary import JsonInputError, parse_json_object

_MODEL = None
_MODEL_ID = None
_VOICE_CACHE: OrderedDict[str, object] = OrderedDict()
_MAX_VOICE_STATES = 8
# Upstream packaged English configurations only: never accept a path/URL as a model.
_MODEL_CONFIGS = {
    "kyutai/pocket-tts": None,
    "english": "english",
    "english_18m_2026-10": "english_18m_2026-10",
    "english_7m_2026-10": "english_7m_2026-10",
    "english_2m_2026-10": "english_2m_2026-10",
}


def _health() -> dict:
    try:
        import pocket_tts  # noqa: F401
        import scipy  # noqa: F401
    except ImportError as exc:
        return {
            "status": "unavailable",
            "error": str(exc),
            "install_hint": "pnpm kyberion voice setup --apply",
        }
    return {"status": "ok", "model": "kyutai/pocket-tts"}


def _model(model_id: str = "kyutai/pocket-tts"):
    global _MODEL, _MODEL_ID
    if model_id not in _MODEL_CONFIGS:
        raise ValueError("Unsupported Pocket TTS model_id; select a packaged English configuration")
    if _MODEL_ID != model_id:
        # Voice state tensors belong to one model, and retaining both models
        # defeats the small-model memory benefit in a warm process.
        _MODEL = None
        _VOICE_CACHE.clear()
        _MODEL_ID = None
    if _MODEL is None:
        from pocket_tts import TTSModel

        config = _MODEL_CONFIGS[model_id]
        _MODEL = TTSModel.load_model(**({"language": config} if config else {}))
        _MODEL_ID = model_id
    return _MODEL


def _voice_state(model, voice: str):
    if voice not in _VOICE_CACHE:
        _VOICE_CACHE[voice] = model.get_state_for_audio_prompt(voice)
        if len(_VOICE_CACHE) > _MAX_VOICE_STATES:
            _VOICE_CACHE.popitem(last=False)
    _VOICE_CACHE.move_to_end(voice)
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

        model_id = str(params.get("model_id") or "kyutai/pocket-tts").strip()
        model = _model(model_id)
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
            "model": model_id,
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
        payload = parse_json_object(raw, "pocket TTS input")
    except JsonInputError as exc:
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

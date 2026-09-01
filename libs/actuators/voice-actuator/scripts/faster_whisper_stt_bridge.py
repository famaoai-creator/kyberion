"""Kyberion Windows-friendly faster-whisper bridge.

Reads a JSON request from stdin and returns one JSON response.  The model can
be kept fully local with KYBERION_STT_MODEL_DIR; otherwise faster-whisper may
download the configured model on first use.
"""
import json
import os
import sys
from json_boundary import parse_json_object


def transcribe(params: dict) -> dict:
    audio_path = str(params.get("audio_path") or "").strip()
    if not audio_path:
        return {"status": "error", "error": "params.audio_path is required"}
    if not os.path.isfile(audio_path):
        return {"status": "error", "error": f"Audio file not found: {audio_path}"}
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        return {"status": "error", "error": f"faster-whisper import failed: {exc}"}

    model_ref = os.environ.get("KYBERION_STT_MODEL_DIR") or os.environ.get(
        "KYBERION_STT_MODEL", "small"
    )
    device = os.environ.get("KYBERION_STT_DEVICE", "cpu")
    compute_type = os.environ.get(
        "KYBERION_STT_COMPUTE_TYPE", "float16" if device != "cpu" else "int8"
    )
    language = str(params.get("language") or os.environ.get("KYBERION_STT_LANGUAGE") or "")
    try:
        model = WhisperModel(model_ref, device=device, compute_type=compute_type)
        segments, info = model.transcribe(audio_path, language=language or None, vad_filter=True)
        segment_list = []
        for segment in segments:
            text = str(segment.text or "").strip()
            if text:
                segment_list.append({"start_sec": float(segment.start), "end_sec": float(segment.end), "text": text})
        return {
            "status": "success",
            "text": " ".join(item["text"] for item in segment_list).strip(),
            "language": getattr(info, "language", language or "auto"),
            "model": model_ref,
            "segments": segment_list,
        }
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


def main() -> int:
    try:
        payload = parse_json_object(sys.stdin.read(), "faster-whisper STT input")
        result = transcribe(payload.get("params") or {}) if payload.get("action") == "transcribe" else {"status": "error", "error": "Unknown action"}
    except Exception as exc:
        result = {"status": "error", "error": str(exc)}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("status") == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main())

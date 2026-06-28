"""
Kyberion espeak-ng TTS Bridge.

Usage (stdin JSON):
  echo '{"action":"generate","params":{...}}' | python3 espeak_ng_tts_bridge.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def _generate(params: dict) -> dict:
    text = str(params.get("text") or "").strip()
    if not text:
      return {"status": "error", "error": "params.text is required"}

    output_path = str(params.get("output_path") or "").strip()
    if not output_path:
      return {"status": "error", "error": "params.output_path is required"}

    language = str(params.get("lang_code") or "en").strip().lower() or "en"
    voice = str(params.get("voice") or "").strip()
    rate = str(params.get("rate") or "").strip()
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    temp_wav = out if out.suffix.lower() == ".wav" else out.with_suffix(".wav")
    espeak_args = ["espeak-ng"]
    if voice:
        espeak_args.extend(["-v", voice])
    elif language.startswith("ja"):
        espeak_args.extend(["-v", "ja"])
    else:
        espeak_args.extend(["-v", language])
    if rate:
        espeak_args.extend(["-s", rate])
    espeak_args.extend(["-w", str(temp_wav), text])

    try:
        subprocess.run(espeak_args, check=True, capture_output=True, text=True)
        if out.suffix.lower() != ".wav":
            subprocess.run(["ffmpeg", "-y", "-i", str(temp_wav), str(out)], check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        return {"status": "error", "error": stderr or str(exc)}

    if not out.exists():
        return {"status": "error", "error": f"Output file was not created: {out}"}

    return {
        "status": "success",
        "output_path": str(out),
        "engine": "espeak-ng",
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

    if action == "generate":
        result = _generate(params)
    else:
        result = {"status": "error", "error": f"Unknown action: {action!r}"}

    print(json.dumps(result))


if __name__ == "__main__":
    main()

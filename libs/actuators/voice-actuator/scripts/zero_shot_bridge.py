"""
Kyberion Zero-Shot Voice Cloning Bridge
Engines tried in order:
  1. CosyVoice 2  via mlx-audio (Apache 2.0, streaming, ja/en/zh)
  2. Fish Speech v1.5 via mlx-audio (Apache 2.0, TTS-Arena #1 ja)
  3. Qwen3-TTS ICL via mlx-audio (existing, ref_audio mode)
  4. macOS `say` fallback

Usage (stdin JSON):
  echo '{"action":"instant_clone_generate","params":{...}}' | python3 zero_shot_bridge.py

Actions:
  instant_clone_generate  — zero-shot clone from ref samples + speak text
  health                  — check available engines
  list_devices            — list audio output devices (for BlackHole routing)
"""

import sys
import json
import os
import shutil
import subprocess
from pathlib import Path


# ---------------------------------------------------------------------------
# Engine probes
# ---------------------------------------------------------------------------

def _probe_cosyvoice() -> bool:
    try:
        import mlx_audio  # noqa: F401
        from mlx_audio.tts.models import cosyvoice  # noqa: F401 — optional submodule
        return True
    except ImportError:
        return False


def _probe_fish_speech() -> bool:
    try:
        import mlx_audio  # noqa: F401
        from mlx_audio.tts.models import fish_speech  # noqa: F401 — optional submodule
        return True
    except ImportError:
        return False


def _probe_mlx_qwen3() -> bool:
    try:
        import mlx_audio  # noqa: F401
        from mlx_audio.tts.generate import generate_audio  # noqa: F401
        return True
    except ImportError:
        return False


def _resolve_generated_output(out: Path) -> Path | None:
    if out.exists():
        return out

    suffix = out.suffix or ".wav"
    candidates: list[Path] = []
    candidates.extend(out.parent.glob(f"{out.stem}{suffix}"))
    candidates.extend(out.parent.glob(f"{out.stem}_*{suffix}"))
    candidates.extend(out.parent.glob(f"{out.stem}-*{suffix}"))
    candidates = [p for p in candidates if p.is_file()]

    if not candidates:
        return None

    candidates.sort(key=lambda p: (p.stat().st_mtime, p.stat().st_size), reverse=True)
    resolved = candidates[0]
    if resolved != out:
        shutil.copy2(resolved, out)
    return out


# ---------------------------------------------------------------------------
# Engine implementations
# ---------------------------------------------------------------------------

def _cosyvoice_generate(text: str, ref_audio: str, ref_text: str, output_path: str, language: str) -> dict:
    """CosyVoice 2 zero-shot via mlx-audio (streaming, 150ms latency)."""
    from mlx_audio.tts.generate import generate_audio
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    generate_audio(
        text=text,
        model="mlx-community/CosyVoice2-0.5B-4bit",
        output_path=str(out.parent),
        file_prefix=out.stem,
        audio_format="wav",
        save=True,
        play=False,
        ref_audio=ref_audio,
        ref_text=ref_text or None,
        stt_model=None if ref_text else "mlx-community/whisper-large-v3-turbo",
    )
    if not _resolve_generated_output(out):
        raise RuntimeError(f"CosyVoice 2 did not produce {out}")
    return {"engine": "cosyvoice2", "output_path": str(out)}


def _fish_speech_generate(text: str, ref_audio: str, output_path: str) -> dict:
    """Fish Speech v1.5 via mlx-audio (TTS-Arena #1 for Japanese)."""
    from mlx_audio.tts.generate import generate_audio
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    generate_audio(
        text=text,
        model="mlx-community/fish-speech-1.5-4bit",
        output_path=str(out.parent),
        file_prefix=out.stem,
        audio_format="wav",
        save=True,
        play=False,
        ref_audio=ref_audio,
    )
    if not _resolve_generated_output(out):
        raise RuntimeError(f"Fish Speech did not produce {out}")
    return {"engine": "fish_speech_v1.5", "output_path": str(out)}


def _qwen3_generate(text: str, ref_audio: str, ref_text: str, output_path: str) -> dict:
    """Qwen3-TTS via mlx-audio with ICL voice cloning (existing engine)."""
    from mlx_audio.tts.generate import generate_audio
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    kwargs: dict = {
        "text": text,
        "model": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit",
        "output_path": str(out.parent),
        "file_prefix": out.stem,
        "audio_format": "wav",
        "save": True,
        "play": False,
        "ref_audio": ref_audio,
    }
    if ref_text:
        kwargs["ref_text"] = ref_text
        kwargs["stt_model"] = None
    generate_audio(**kwargs)
    if not _resolve_generated_output(out):
        raise RuntimeError(f"Qwen3-TTS did not produce {out}")
    return {"engine": "qwen3_tts_icl", "output_path": str(out)}


def _macos_say_fallback(text: str, output_path: str) -> dict:
    """macOS /usr/bin/say last-resort fallback."""
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    aiff = out.with_suffix(".aiff")
    subprocess.run(["/usr/bin/say", "-v", "Kyoko", "-o", str(aiff), text], check=True)
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16", str(aiff), str(out)], check=False)
    if not out.exists() and aiff.exists():
        shutil.copy(aiff, out)  # keep aiff as last resort
    return {"engine": "macos_say_fallback", "output_path": str(out)}


# ---------------------------------------------------------------------------
# Main action: instant_clone_generate
# ---------------------------------------------------------------------------

def instant_clone_and_generate(
    text: str,
    profile_id: str,
    sample_dir: str,
    output_path: str,
    language: str = "ja",
    preferred_engine: str = "auto",
) -> dict:
    """
    Zero-shot voice clone from sample directory, then generate speech.

    Engine selection (preferred_engine='auto'):
      cosyvoice2 → fish_speech → qwen3_tts → macos_say
    """
    sample_path = Path(sample_dir)
    if not sample_path.exists():
        return {"status": "error", "error": f"Sample directory not found: {sample_dir}"}

    samples = sorted(
        list(sample_path.glob("*.wav")) + list(sample_path.glob("*.mp3")),
        key=lambda p: p.stat().st_size,
        reverse=True,  # prefer longest sample
    )
    if not samples:
        return {"status": "error", "error": "No .wav/.mp3 samples found in sample_dir"}

    ref_audio = str(samples[0])
    ref_text_path = sample_path / "ref_text.txt"
    ref_text = ref_text_path.read_text(encoding="utf-8").strip() if ref_text_path.exists() else ""

    if not output_path:
        output_path = f"active/shared/tmp/voice-out/{profile_id}/generated.wav"

    errors: list[str] = []

    # Try engines in priority order
    engines_to_try: list[str] = []
    if preferred_engine == "auto":
        engines_to_try = ["cosyvoice2", "fish_speech", "qwen3_tts", "macos_say"]
    else:
        engines_to_try = [preferred_engine, "macos_say"]

    for engine in engines_to_try:
        try:
            if engine == "cosyvoice2" and _probe_cosyvoice():
                result = _cosyvoice_generate(text, ref_audio, ref_text, output_path, language)
                return {"status": "success", "profile_id": profile_id, "ref_audio": ref_audio, **result}

            elif engine == "fish_speech" and _probe_fish_speech():
                result = _fish_speech_generate(text, ref_audio, output_path)
                return {"status": "success", "profile_id": profile_id, "ref_audio": ref_audio, **result}

            elif engine == "qwen3_tts" and _probe_mlx_qwen3():
                result = _qwen3_generate(text, ref_audio, ref_text, output_path)
                return {"status": "success", "profile_id": profile_id, "ref_audio": ref_audio, **result}

            elif engine == "macos_say":
                result = _macos_say_fallback(text, output_path)
                return {"status": "success", "profile_id": profile_id, "ref_audio": None, **result,
                        "warning": "Used macOS say fallback — voice clone NOT applied"}

        except Exception as exc:
            errors.append(f"{engine}: {exc}")
            continue

    return {"status": "error", "error": "All engines failed", "details": errors}


# ---------------------------------------------------------------------------
# health / list_devices
# ---------------------------------------------------------------------------

def _health() -> dict:
    return {
        "status": "ok",
        "engines": {
            "cosyvoice2": _probe_cosyvoice(),
            "fish_speech_v1.5": _probe_fish_speech(),
            "qwen3_tts_icl": _probe_mlx_qwen3(),
            "macos_say": os.path.exists("/usr/bin/say"),
        },
        "install_hints": {
            "cosyvoice2": "pip install mlx-audio  # then: mlx-audio pulls CosyVoice2 on first use",
            "fish_speech": "pip install mlx-audio  # then: mlx-audio pulls Fish Speech on first use",
        },
    }


def _list_devices() -> dict:
    try:
        import sounddevice as sd
        devs = sd.query_devices()
        return {
            "status": "ok",
            "devices": [
                {"index": i, "name": d["name"], "max_output_channels": d["max_output_channels"]}
                for i, d in enumerate(devs)
                if d["max_output_channels"] > 0
            ],
            "blackhole_found": any("BlackHole" in d["name"] for d in devs),
        }
    except ImportError:
        return {"status": "unavailable", "error": "sounddevice not installed — pip install sounddevice"}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    # Accept argv[1] (pipeline shell cmd pattern) or stdin
    if len(sys.argv) >= 2:
        raw = sys.argv[1].strip()
    else:
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
        result = _health()
    elif action == "list_devices":
        result = _list_devices()
    elif action == "instant_clone_generate":
        result = instant_clone_and_generate(
            text=params.get("text", ""),
            profile_id=params.get("profile_id", ""),
            sample_dir=params.get("sample_dir", ""),
            output_path=params.get("output_path", ""),
            language=params.get("language", "ja"),
            preferred_engine=params.get("preferred_engine", "auto"),
        )
    else:
        result = {"status": "error", "error": f"Unknown action: {action!r}"}

    print(json.dumps(result))


if __name__ == "__main__":
    main()

from __future__ import annotations

"""
Kyberion Voice Learning Bridge — zero-shot engine cascade.

Usage (sys.argv[1] JSON):
  python3 voice_learning_bridge.py '{"action":"learn","params":{...}}'
  python3 voice_learning_bridge.py '{"action":"generate","params":{...}}'
  python3 voice_learning_bridge.py '{"action":"health"}'

Actions:
  learn    — validate samples, cache profile metadata for zero-shot cloning
  generate — synthesize speech with cloned voice (cosyvoice2→fish_speech→qwen3→macos_say)
  health   — check engine availability
"""

import sys
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

PROFILE_CACHE_ROOT = Path("active/shared/tmp/voice-profiles")
PROFILE_REGISTRY_PATH = Path("knowledge/personal/voice/profile-registry.json")


# ---------------------------------------------------------------------------
# Profile metadata helpers
# ---------------------------------------------------------------------------

def _profile_cache_path(profile_id: str) -> Path:
    return PROFILE_CACHE_ROOT / profile_id / "metadata.json"


def _load_profile_meta(profile_id: str) -> dict | None:
    """Load profile from cache; fall back to knowledge/personal/voice/profile-registry.json."""
    meta_path = _profile_cache_path(profile_id)
    if meta_path.exists():
        try:
            return json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    # Fall back to profile registry (sample_refs → best_sample)
    if PROFILE_REGISTRY_PATH.exists():
        try:
            registry = json.loads(PROFILE_REGISTRY_PATH.read_text(encoding="utf-8"))
            for profile in registry.get("profiles", []):
                if profile.get("profile_id") == profile_id:
                    sample_refs = profile.get("sample_refs", [])
                    if not sample_refs:
                        return None
                    # Pick largest existing sample as best
                    existing = [
                        (Path(s).stat().st_size, s) for s in sample_refs if Path(s).exists()
                    ]
                    if not existing:
                        return None
                    best = max(existing, key=lambda x: x[0])[1]
                    return {
                        "profile_id": profile_id,
                        "language": (profile.get("languages") or ["ja"])[0],
                        "best_sample": str(Path(best).resolve()),
                        "all_samples": [str(Path(s).resolve()) for _, s in sorted(existing, reverse=True)],
                        "ref_text": "",
                        "sample_count": len(existing),
                        "source": "profile_registry",
                    }
        except Exception:
            pass

    return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resolve_generated_output(out: Path) -> Path | None:
    """Find the file mlx_audio actually wrote and normalize it to `out`."""
    if out.exists():
        return out

    suffix = out.suffix or ".wav"
    suffixes = []
    if suffix.startswith("."):
        suffixes.append(suffix)
    else:
        suffixes.append(f".{suffix}")

    candidates: list[Path] = []
    for ext in suffixes:
        candidates.extend(out.parent.glob(f"{out.stem}{ext}"))
        candidates.extend(out.parent.glob(f"{out.stem}_*{ext}"))
        candidates.extend(out.parent.glob(f"{out.stem}-*{ext}"))

    candidates = [p for p in candidates if p.is_file()]
    if not candidates:
        return None

    candidates.sort(key=lambda p: (p.stat().st_mtime, p.stat().st_size), reverse=True)
    resolved = candidates[0]
    if resolved != out:
        out.write_bytes(resolved.read_bytes())
    return out


# ---------------------------------------------------------------------------
# Engine probes
# ---------------------------------------------------------------------------

def _probe_cosyvoice() -> bool:
    try:
        import mlx_audio  # noqa: F401
        from mlx_audio.tts.models import cosyvoice  # noqa: F401
        return True
    except ImportError:
        return False


def _probe_fish_speech() -> bool:
    try:
        import mlx_audio  # noqa: F401
        from mlx_audio.tts.models import fish_speech  # noqa: F401
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


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------

def action_learn(params: dict) -> dict:
    profile_id = str(params.get("profile_id") or "").strip()
    sample_dir = str(params.get("sample_dir") or "").strip()
    language = str(params.get("language") or "ja").strip()

    if not profile_id:
        return {"status": "error", "error": "profile_id is required"}
    if not sample_dir:
        return {"status": "error", "error": "sample_dir is required"}

    sample_path = Path(sample_dir)
    if not sample_path.exists():
        return {"status": "error", "error": f"sample_dir not found: {sample_dir}"}

    samples = sorted(
        list(sample_path.glob("*.wav")) + list(sample_path.glob("*.mp3")),
        key=lambda p: p.stat().st_size,
        reverse=True,  # largest file first = longest clip = best ref
    )
    if not samples:
        return {"status": "error", "error": "No .wav/.mp3 samples found in sample_dir"}

    best_sample = samples[0]
    ref_text_path = sample_path / "ref_text.txt"
    ref_text = ref_text_path.read_text(encoding="utf-8").strip() if ref_text_path.exists() else ""

    cache_dir = PROFILE_CACHE_ROOT / profile_id
    cache_dir.mkdir(parents=True, exist_ok=True)

    meta = {
        "profile_id": profile_id,
        "language": language,
        "sample_dir": str(sample_path.resolve()),
        "best_sample": str(best_sample.resolve()),
        "all_samples": [str(s.resolve()) for s in samples],
        "ref_text": ref_text,
        "sample_count": len(samples),
        "registered_at": _now_iso(),
    }
    meta_path = cache_dir / "metadata.json"
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")

    return {
        "status": "success",
        "profile_id": profile_id,
        "sample_count": len(samples),
        "best_sample": str(best_sample),
        "ref_text_found": bool(ref_text),
        "metadata_path": str(meta_path),
    }


def action_generate(params: dict) -> dict:
    text = str(params.get("text") or "").strip()
    profile_id = str(params.get("profile_id") or "").strip()
    output_path = str(params.get("output_path") or "").strip()
    language = str(params.get("language") or "ja").strip()
    preferred_engine = str(params.get("preferred_engine") or "auto").strip()

    if not text:
        return {"status": "error", "error": "text is required"}
    if not profile_id:
        return {"status": "error", "error": "profile_id is required"}

    meta = _load_profile_meta(profile_id)
    if not meta:
        return {
            "status": "error",
            "error": f"Profile '{profile_id}' not found — run action=learn first.",
        }

    if not output_path:
        output_path = f"active/shared/tmp/voice-out/{profile_id}/generated.wav"

    ref_audio = meta.get("best_sample", "")
    ref_text = meta.get("ref_text", "")

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    engines = (
        ["cosyvoice2", "fish_speech", "qwen3_tts", "macos_say"]
        if preferred_engine == "auto"
        else [preferred_engine, "macos_say"]
    )

    errors: list[str] = []

    for engine in engines:
        try:
            if engine == "cosyvoice2" and _probe_cosyvoice():
                from mlx_audio.tts.generate import generate_audio
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
                resolved = _resolve_generated_output(out)
                if resolved:
                    return {
                        "status": "success",
                        "engine": "cosyvoice2",
                        "output_path": str(resolved),
                        "profile_id": profile_id,
                    }
                errors.append("cosyvoice2: output file not produced")

            elif engine == "fish_speech" and _probe_fish_speech():
                from mlx_audio.tts.generate import generate_audio
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
                resolved = _resolve_generated_output(out)
                if resolved:
                    return {
                        "status": "success",
                        "engine": "fish_speech_v1.5",
                        "output_path": str(resolved),
                        "profile_id": profile_id,
                    }
                errors.append("fish_speech: output file not produced")

            elif engine == "qwen3_tts" and _probe_mlx_qwen3():
                from mlx_audio.tts.generate import generate_audio
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
                resolved = _resolve_generated_output(out)
                if resolved:
                    return {
                        "status": "success",
                        "engine": "qwen3_tts_icl",
                        "output_path": str(resolved),
                        "profile_id": profile_id,
                    }
                errors.append("qwen3_tts: output file not produced")

            elif engine == "macos_say":
                aiff = out.with_suffix(".aiff")
                subprocess.run(
                    ["/usr/bin/say", "-v", "Kyoko", "-o", str(aiff), text], check=True
                )
                subprocess.run(
                    ["afconvert", "-f", "WAVE", "-d", "LEI16", str(aiff), str(out)],
                    check=False,
                )
                if not out.exists() and aiff.exists():
                    shutil.copy(aiff, out)
                return {
                    "status": "success",
                    "engine": "macos_say_fallback",
                    "output_path": str(out),
                    "profile_id": profile_id,
                    "warning": "Used macOS say — voice clone NOT applied",
                }

        except Exception as exc:
            errors.append(f"{engine}: {exc}")

    return {"status": "error", "error": "All engines failed", "details": errors}


def action_health() -> dict:
    return {
        "status": "ok",
        "engines": {
            "cosyvoice2": _probe_cosyvoice(),
            "fish_speech_v1.5": _probe_fish_speech(),
            "qwen3_tts_icl": _probe_mlx_qwen3(),
            "macos_say": Path("/usr/bin/say").exists(),
        },
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Accept JSON as argv[1] (pipeline shell cmd convention) or stdin
    if len(sys.argv) >= 2:
        raw = sys.argv[1]
    else:
        raw = sys.stdin.read().strip()

    if not raw:
        print(json.dumps({"status": "error", "error": "No JSON input provided"}))
        sys.exit(1)

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(json.dumps({"status": "error", "error": f"Invalid JSON: {exc}"}))
        sys.exit(1)

    action = payload.get("action")
    params = payload.get("params") or {}

    if action == "learn":
        result = action_learn(params)
    elif action == "generate":
        result = action_generate(params)
    elif action == "health":
        result = action_health()
    else:
        result = {"status": "error", "error": f"Unknown action: {action!r}"}

    print(json.dumps(result, ensure_ascii=False))

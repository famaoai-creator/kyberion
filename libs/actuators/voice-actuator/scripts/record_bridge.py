import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


# Kyberion Voice Recorder Bridge (macOS focused)
# Captures audio for voice cloning reference.


def _guard_output_path(raw_path):
    resolved = Path(raw_path).expanduser().resolve()
    root = Path(os.environ.get("KYBERION_PROJECT_ROOT") or Path.cwd()).resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError("output_path must stay inside the Kyberion project root") from exc
    approved = [
        root / "active" / "shared" / "tmp",
        root / "active" / "shared" / "runtime" / "voice-profiles",
        root / "knowledge" / "personal" / "voice",
    ]
    if not any(resolved == base or base in resolved.parents for base in approved):
        raise ValueError("output_path is outside an approved voice data directory")
    return resolved


def _render_progress(elapsed, duration):
    total = max(float(duration), 0.1)
    bounded = min(max(float(elapsed), 0.0), total)
    ratio = bounded / total
    width = 32
    filled = int(round(width * ratio))
    return f"[{'█' * filled}{'░' * (width - filled)}] {bounded:5.1f}/{total:5.1f}s"


def _probe_recording(path):
    """Return basic media metrics so a silent/short capture is not accepted."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe or not Path(path).exists():
        return None

    result = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        duration = float(result.stdout.strip())
    except (TypeError, ValueError):
        return None
    if duration <= 0:
        return None
    return {"duration_sec": duration, "bytes": Path(path).stat().st_size}


def record_sample(output_path, duration=10, prompt_text=None, countdown_sec=3, prompt_hold_ms=0):
    """Show the script, count down, then turn on the microphone and record."""
    out = _guard_output_path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    countdown_sec = max(int(countdown_sec), 0)

    print("\n🎙️  録音準備")
    print(f"   保存先: {output_path}")
    if prompt_text:
        print("\n📖  次の文章を読み上げてください:")
        print(f"   「{prompt_text}」")
        hold_ms = max(float(prompt_hold_ms or 0), 0.0)
        if hold_ms > 0:
            time.sleep(hold_ms / 1000.0)
    print(f"\n   {countdown_sec} 秒後にマイクを ON にします。")

    if shutil.which("sox"):
        cmd = ["sox", "-q", "-d", str(out), "trim", "0", str(duration)]
        method = "sox"
    elif shutil.which("ffmpeg"):
        cmd = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "avfoundation",
            "-i",
            ":0",
            "-t",
            str(duration),
            str(out),
        ]
        method = "ffmpeg"
    else:
        return {
            "status": "manual_action_required",
            "message": "sox or ffmpeg not found in path. Please install ffmpeg.",
            "target_dir": str(out.parent),
        }

    proc = None
    try:
        for remaining in range(countdown_sec, 0, -1):
            sys.stdout.write(f"\r   🎙️  マイク ON まで {remaining} 秒... ")
            sys.stdout.flush()
            time.sleep(1.0)
        sys.stdout.write("\r   🔴  録音開始。読み上げてください。             \n")
        sys.stdout.flush()

        # Start the microphone only after the script and countdown are visible.
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        started_at = time.monotonic()
        while proc.poll() is None:
            elapsed = time.monotonic() - started_at
            sys.stdout.write(f"\r    {_render_progress(elapsed, duration)} ")
            sys.stdout.flush()
            time.sleep(0.25)
        proc.wait(timeout=5)
        if proc.returncode != 0:
            return {"status": "error", "message": f"Recording process exited with code {proc.returncode}."}

        metrics = _probe_recording(out)
        if not metrics:
            return {"status": "error", "message": "Recording produced no readable audio file."}
        if metrics["duration_sec"] < max(1.0, float(duration) * 0.75):
            return {
                "status": "error",
                "message": f"Recording was too short ({metrics['duration_sec']:.1f}s of {duration}s).",
                "duration_sec": metrics["duration_sec"],
            }

        sys.stdout.write(f"\r    {_render_progress(metrics['duration_sec'], duration)} ✅\n")
        sys.stdout.flush()
        print(f"\n✅  収録成功: {out.name} ({metrics['duration_sec']:.1f} 秒)\n")
        return {"status": "success", "path": str(out), "method": method, **metrics}
    except subprocess.TimeoutExpired:
        if proc is not None:
            proc.terminate()
        return {"status": "error", "message": "Recording process timed out."}
    except Exception as exc:
        if proc is not None and proc.poll() is None:
            proc.terminate()
        return {"status": "error", "message": str(exc)}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(1)

    try:
        input_data = json.loads(sys.argv[1])
        action = input_data.get("action")
        params = input_data.get("params", {})

        if action == "record":
            duration = params.get("duration", 10)
            output_path = params.get(
                "output_path",
                "knowledge/personal/voice/samples/operator-default-v1/sample_recorded.wav",
            )
            result = record_sample(
                output_path,
                duration,
                params.get("prompt_text"),
                params.get("countdown_sec", 3),
                params.get("prompt_hold_ms", 0),
            )
            print(json.dumps(result))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))

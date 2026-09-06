#!/usr/bin/env python3
"""VTuber-lite talking-avatar renderer (offline: PIL + numpy + ffmpeg only).

Turns a front-facing portrait plus a speech audio file into an MP4:
slow Ken Burns zoom, a volume-driven cartoon mouth, and periodic blinks.
Stylized by design — illustrated portraits work best; photorealistic
faces get a visible cartoon mouth overlay (honest synthetic look).

Usage:
    talking_avatar_render.py --portrait in.png --audio speech.wav \
        --output out.mp4 [--fps 12] [--width 1280] [--height 720] \
        [--max-duration-sec 300]

Face geometry is heuristic (face center ~ middle, mouth ~70% height).
For landmark-accurate lipsync use a dedicated model instead.
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

try:
    import numpy as np
except ImportError:
    print(json.dumps({"status": "error", "message": "numpy is required"}))
    sys.exit(1)

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:
    print(json.dumps({"status": "error", "message": "PIL (pillow) is required"}))
    sys.exit(1)


def run(cmd, **kwargs):
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def decode_mono_16k(audio_path):
    """Decode any audio to mono 16kHz s16le samples via ffmpeg."""
    proc = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-i", audio_path, "-ac", "1", "-ar", "16000",
            "-c:a", "pcm_s16le", "-f", "s16le", "-",
        ],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg decode failed: {proc.stderr[-300:]}")
    samples = np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    return samples


def volume_envelope(samples, window_sec=0.05, fps=12):
    """Per-frame 0..1 loudness envelope with a noise gate."""
    window = max(1, int(16000 * window_sec))
    weights = np.ones(window) / window
    rms = np.sqrt(np.convolve(samples ** 2, weights, mode="same"))
    frame_step = max(1, int(16000 / fps))
    frame_rms = rms[::frame_step]
    gate = 0.02
    env = np.clip((frame_rms - gate) / (0.35 - gate), 0.0, 1.0)
    return env


def cover_background(portrait, width, height):
    """Center-crop cover image with a blurred fill for odd aspects."""
    bg = portrait.convert("RGB").resize((width, height))
    bg = bg.filter(ImageFilter.GaussianBlur(24))
    scale = max(width / portrait.width, height / portrait.height)
    fg = portrait.convert("RGB").resize(
        (int(portrait.width * scale) + 1, int(portrait.height * scale) + 1)
    )
    left = (fg.width - width) // 2
    top = (fg.height - height) // 2
    bg.paste(fg.crop((left, top, left + width, top + height)), (0, 0))
    return bg


def skin_tone(base):
    w, h = base.size
    box = base.crop((int(w * 0.35), int(h * 0.18), int(w * 0.65), int(h * 0.30)))
    pixels = np.asarray(box).reshape(-1, 3).mean(axis=0)
    return tuple(int(v) for v in pixels)


def render_frame(base, env, frame_index, fps, skin, geom):
    w, h = base.size
    # Slow Ken Burns zoom loop.
    zoom = 1.0 + 0.05 * (0.5 - 0.5 * math.cos(2 * math.pi * frame_index / (fps * 12)))
    zw, zh = int(w * zoom), int(h * zoom)
    zoomed = base.resize((zw, zh))
    frame = zoomed.crop(((zw - w) // 2, (zh - h) // 2, (zw - w) // 2 + w, (zh - h) // 2 + h))
    draw = ImageDraw.Draw(frame, "RGBA")

    # Mouth: volume-driven open ellipse, thin line when silent.
    mx, my = w * geom["mouth_x"], h * geom["mouth_y"]
    mw = w * geom["mouth_w"]
    if env > 0.08:
        mh = 2 + env * h * 0.022
        draw.ellipse([mx - mw, my - mh, mx + mw, my + mh], fill=(122, 28, 32, 235))
        draw.ellipse(
            [mx - mw * 0.55, my - mh * 0.45, mx + mw * 0.55, my + mh * 0.5],
            fill=(70, 12, 16, 235),
        )
    else:
        draw.line([mx - mw, my, mx + mw, my], fill=(90, 40, 44, 235), width=max(2, h // 360))

    # Blink: brief eyelid bar roughly every 3.4s.
    period_frames = int(fps * 3.4)
    if period_frames > 0 and (frame_index % period_frames) < max(1, int(fps * 0.12)):
        ey, ex1, ex2 = h * geom["eyes_y"], w * 0.40, w * 0.60
        draw.rectangle([ex1 - mw * 0.7, ey - 3, ex1 + mw * 0.35, ey + 3], fill=skin + (255,))
        draw.rectangle([ex2 - mw * 0.35, ey - 3, ex2 + mw * 0.7, ey + 3], fill=skin + (255,))

    return frame


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--portrait", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--fps", type=int, default=12)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--max-duration-sec", type=float, default=300)
    parser.add_argument("--mouth-x", type=float, default=0.5)
    parser.add_argument("--mouth-y", type=float, default=0.70)
    parser.add_argument("--mouth-w", type=float, default=0.055)
    parser.add_argument("--eyes-y", type=float, default=0.40)
    args = parser.parse_args()
    geom = {
        "mouth_x": args.mouth_x,
        "mouth_y": args.mouth_y,
        "mouth_w": args.mouth_w,
        "eyes_y": args.eyes_y,
    }

    for label, value in (("portrait", args.portrait), ("audio", args.audio)):
        if not os.path.isfile(value):
            print(json.dumps({"status": "error", "message": f"{label} not found: {value}"}))
            sys.exit(1)

    try:
        portrait = Image.open(args.portrait)
    except Exception as exc:
        print(json.dumps({"status": "error", "message": f"cannot open portrait: {exc}"}))
        sys.exit(1)

    fps = min(30, max(5, args.fps))
    try:
        samples = decode_mono_16k(args.audio)
    except RuntimeError as exc:
        print(json.dumps({"status": "error", "message": str(exc)}))
        sys.exit(1)

    duration_sec = min(len(samples) / 16000.0, args.max_duration_sec)
    if duration_sec <= 0:
        print(json.dumps({"status": "error", "message": "audio has no samples"}))
        sys.exit(1)
    frame_count = max(1, int(duration_sec * fps))
    env = volume_envelope(samples, fps=fps)
    if len(env) < frame_count:
        env = np.pad(env, (0, frame_count - len(env)))

    base = cover_background(portrait, args.width, args.height)
    skin = skin_tone(base)

    tmpdir = tempfile.mkdtemp(prefix="talking-avatar-")
    try:
        for index in range(frame_count):
            frame = render_frame(base, float(env[index]), index, fps, skin, geom)
            frame.save(os.path.join(tmpdir, f"frame{index:05d}.png"))
        out_dir = os.path.dirname(os.path.abspath(args.output))
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        result = run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-framerate", str(fps), "-i", os.path.join(tmpdir, "frame%05d.png"),
                "-i", args.audio,
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-shortest", args.output,
            ]
        )
        if result.returncode != 0:
            print(json.dumps({"status": "error", "message": f"ffmpeg encode failed: {result.stderr[-300:]}"}))
            sys.exit(1)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    print(
        json.dumps(
            {
                "status": "success",
                "output": os.path.abspath(args.output),
                "duration_sec": round(duration_sec, 2),
                "fps": fps,
                "frames": frame_count,
                "width": args.width,
                "height": args.height,
            }
        )
    )


if __name__ == "__main__":
    main()

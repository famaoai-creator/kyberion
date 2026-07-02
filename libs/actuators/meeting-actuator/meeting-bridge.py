"""Kyberion Meeting Bridge.

Thin platform driver that dispatches to Zoom / Microsoft Teams / Google
Meet via the Playwright-based meeting-browser-driver. The TS layer
(`libs/actuators/meeting-actuator/src/index.ts`) shells out to this
script with one JSON payload on stdin per call and parses one JSON
envelope back.

Contract (input → output):

    Input:
        { "action": "join|leave|speak|listen|chat|status",
          "params": { "platform": "zoom|teams|meet|auto", "url": ...,
                      "duration_sec": N, "passcode": ..., "text": ...,
                      "name": ..., "profile_id": ..., ... } }

    Output (always one line of JSON):
        { "status": "success|error|denied",
          "platform": ..., "method": ..., "message": ...,
          "join_backend": ...,  # internal browser join backend label
          "partial_state": bool, "partial_reason": ...,
          "transcript_path": ..., ... }

join() runs the full session (join → wait duration_sec → leave) via
playwright-meet-join.mjs. speak() generates TTS via voice_learning_bridge
and plays it through BlackHole. listen() and leave() are no-ops when the
session runs within join().
"""

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

# Repo root = three levels up from this script's directory
_SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = _SCRIPT_DIR.parents[2]

PLAYWRIGHT_JOIN = ROOT / "libs/actuators/meeting-browser-driver/scripts/playwright-meet-join.mjs"
MEETING_JOIN_BACKEND = "meeting-browser-driver"
VOICE_BRIDGE    = ROOT / "libs/actuators/voice-actuator/scripts/voice_learning_bridge.py"
BLACKHOLE       = ROOT / "libs/actuators/voice-actuator/scripts/blackhole_audio_router.py"

ALLOWED_HOSTS = {
    "zoom":  ("zoom.us", "zoom.com", "app.zoom.us"),
    "teams": ("teams.microsoft.com", "teams.live.com", "microsoft.com"),
    "meet":  ("meet.google.com",),
}

DEFAULT_DISPLAY_NAME = "Kyberion Agent"


def _resolve_default_python_bin():
    env_candidates = [
        os.environ.get("KYBERION_PYTHON_BIN"),
        os.environ.get("KYBERION_PYTHON"),
    ]
    managed_candidates = [
        ROOT / "active/shared/runtime/tool-runtimes/mlx-audio/bin/python",
        ROOT / "active/shared/runtime/tool-runtimes/mlx-audio/bin/python3",
        ROOT / "active/shared/runtime/tool-runtimes/mlx-whisper/bin/python",
        ROOT / "active/shared/runtime/tool-runtimes/mlx-whisper/bin/python3",
    ]
    legacy_candidates = [
        ROOT / ".venv/bin/python3",
    ]

    for candidate in env_candidates:
        if candidate:
            return candidate
    for candidate in managed_candidates + legacy_candidates:
        if Path(candidate).exists():
            return str(candidate)
    return "python3"


DEFAULT_PYTHON_BIN = _resolve_default_python_bin()


def _err(message, **extra):
    payload = {"status": "error", "message": message}
    payload.update(extra)
    return payload


def _validate_url(platform, url):
    if not url:
        return False, "url is required"
    try:
        parsed = urlparse(url)
    except ValueError as exc:
        return False, f"invalid url: {exc}"
    if parsed.scheme not in ("http", "https"):
        return False, f"url scheme must be http(s); got '{parsed.scheme}'"
    allow = ALLOWED_HOSTS.get(platform, ())
    if allow and not any(parsed.netloc.endswith(h) for h in allow):
        return False, f"url host '{parsed.netloc}' not in allow-list for {platform}"
    return True, None


def _detect_platform(url):
    try:
        parsed = urlparse(url)
        host = parsed.netloc
        pathname = parsed.path.lower()
    except Exception:
        return "meet"
    if host.endswith("zoom.us") or host.endswith("zoom.com"):
        return "zoom"
    if host.endswith("teams.microsoft.com") or host.endswith("teams.live.com"):
        return "teams"
    if host.endswith("microsoft.com") and "/microsoft-teams/join-a-meeting" in pathname:
        return "teams"
    return "meet"


def _provider_to_platform(provider):
    if provider in ("google_meet", "meet"):
        return "meet"
    if provider in ("teams_pipeline", "teams"):
        return "teams"
    if provider == "zoom":
        return "zoom"
    return "auto"


class MeetingBridge:
    """Playwright-backed meeting driver."""

    def _join_backend_label(self) -> str:
        return MEETING_JOIN_BACKEND if PLAYWRIGHT_JOIN.exists() else "stub"

    # ---- join ---------------------------------------------------- #

    def join(self, platform, url=None, meeting_id=None, passcode=None,
             duration_sec=0, name=None, profile_id=None, audio_path=None,
             screenshot_path=None, python_bin=None, provider=None,
             provider_profile_id=None, execution_profile_id=None, mode=None,
             node=None, audio_bridge=None, url_policy=None):
        """Run the full meeting session via playwright-meet-join.mjs.

        duration_sec=0 means join, take a screenshot, and immediately leave.
        """
        sys.stderr.write(
            f"[bridge] join platform={platform} provider={provider} mode={mode} "
            f"duration={duration_sec}s\n"
        )

        if platform == "auto":
            provider_platform = _provider_to_platform(provider)
            if provider_platform != "auto":
                platform = provider_platform
            else:
                platform = _detect_platform(url or "")
        if provider_platform := _provider_to_platform(provider):
            if platform == "auto":
                platform = provider_platform

        ok, reason = _validate_url(platform, url)
        if not ok:
            return _err(reason, platform=platform)

        if not PLAYWRIGHT_JOIN.exists():
            return _err(
                f"playwright-meet-join.mjs not found at {PLAYWRIGHT_JOIN}. "
                "Run: pnpm install && check libs/actuators/meeting-browser-driver/",
                platform=platform,
            )

        cmd = ["node", str(PLAYWRIGHT_JOIN),
               "--url", url,
               "--name", name or DEFAULT_DISPLAY_NAME,
               "--wait", str(int(duration_sec))]

        if passcode:
            cmd += ["--passcode", passcode]
        if meeting_id:
            cmd += ["--meeting-id", meeting_id]
        if audio_path:
            cmd += ["--audio", audio_path]
        if screenshot_path:
            cmd += ["--screenshot", screenshot_path]
        if python_bin:
            cmd += ["--python", python_bin]

        sys.stderr.write(
            f"[bridge] running: {' '.join(cmd[:6])} ... "
            f"profile={provider_profile_id or execution_profile_id or 'n/a'}\n"
        )
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, cwd=str(ROOT),
                timeout=max(120, int(duration_sec) + 60),
            )
        except subprocess.TimeoutExpired:
            return _err("playwright-meet-join.mjs timed out", platform=platform)
        except Exception as exc:
            return _err(f"failed to launch playwright: {exc}", platform=platform)

        # playwright-meet-join.mjs prints JSON on the last stdout line
        lines = [l for l in result.stdout.strip().splitlines() if l.strip()]
        for line in reversed(lines):
            try:
                payload = json.loads(line)
                if "status" in payload:
                    sys.stderr.write(f"[bridge] join result: {payload}\n")
                    payload.setdefault("join_backend", self._join_backend_label())
                    if provider:
                        payload.setdefault("provider", provider)
                    if provider_profile_id:
                        payload.setdefault("provider_profile_id", provider_profile_id)
                    if execution_profile_id:
                        payload.setdefault("execution_profile_id", execution_profile_id)
                    if mode:
                        payload.setdefault("mode", mode)
                    if node:
                        payload.setdefault("node", node)
                    if audio_bridge:
                        payload.setdefault("audio_bridge", audio_bridge)
                    if url_policy:
                        payload.setdefault("url_policy", url_policy)
                    return payload
            except json.JSONDecodeError:
                continue

        stderr_snippet = (result.stderr or "")[-400:]
        return _err(
            f"playwright-meet-join.mjs produced no JSON output (rc={result.returncode}). "
            f"stderr: {stderr_snippet}",
            platform=platform,
        )

    # ---- speak --------------------------------------------------- #

    def speak(self, text, platform="auto", profile_id=None, python_bin=None,
              language="ja", preferred_engine="auto"):
        """Generate TTS via voice_learning_bridge.py and play through BlackHole."""
        sys.stderr.write(f"[bridge] speak chars={len(text or '')}\n")
        if not text:
            return _err("speak.text is required")

        python = python_bin or DEFAULT_PYTHON_BIN
        if not Path(python).exists():
            python = shutil.which("python3") or "python3"

        tmp_wav = str(ROOT / "active/shared/tmp/meeting-speak-out.wav")

        if VOICE_BRIDGE.exists() and profile_id:
            # TTS via voice_learning_bridge.py
            gen_payload = json.dumps({
                "action": "generate",
                "params": {
                    "text": text,
                    "profile_id": profile_id,
                    "output_path": tmp_wav,
                    "language": language,
                    "preferred_engine": preferred_engine,
                },
            })
            try:
                r = subprocess.run(
                    [python, str(VOICE_BRIDGE), gen_payload],
                    capture_output=True, text=True, cwd=str(ROOT), timeout=120,
                )
                gen_result = {}
                for line in reversed(r.stdout.strip().splitlines()):
                    try:
                        gen_result = json.loads(line)
                        break
                    except json.JSONDecodeError:
                        continue
                if gen_result.get("status") not in ("success", "ok"):
                    return _err(f"TTS generation failed: {gen_result.get('message', r.stderr[-200:])}")
            except Exception as exc:
                return _err(f"TTS generation exception: {exc}")

            # Play through BlackHole
            if BLACKHOLE.exists() and Path(tmp_wav).exists():
                play_payload = json.dumps({
                    "action": "play_to_blackhole",
                    "params": {"wav_path": tmp_wav},
                })
                try:
                    r2 = subprocess.run(
                        [python, str(BLACKHOLE), play_payload],
                        capture_output=True, text=True, cwd=str(ROOT), timeout=120,
                    )
                    return {"status": "success", "action": "speak", "chars": len(text), "method": "blackhole"}
                except Exception as exc:
                    return _err(f"BlackHole playback failed: {exc}")
            return {"status": "success", "action": "speak", "chars": len(text), "method": "tts_only"}

        # Fallback: macOS say
        if sys.platform == "darwin":
            rc = subprocess.run(["say", text]).returncode
            if rc != 0:
                return _err(f"say failed (rc={rc})")
            return {"status": "success", "action": "speak", "chars": len(text), "method": "macos_say"}
        elif shutil.which("espeak"):
            rc = subprocess.run(["espeak", text]).returncode
            if rc != 0:
                return _err(f"espeak failed (rc={rc})")
            return {"status": "success", "action": "speak", "chars": len(text), "method": "espeak"}
        return _err("no speech synthesizer available (need voice profile + BlackHole, or say/espeak)")

    # ---- listen -------------------------------------------------- #

    def listen(self, duration_sec=10, transcript_path=None):
        """Receive audio.

        When join() runs as a full session (duration_sec > 0), listen is
        a no-op — the playwright browser is already capturing the meeting.
        As a standalone action, this stub waits duration_sec seconds.
        """
        sys.stderr.write(f"[bridge] listen duration={duration_sec}\n")
        try:
            duration = max(0, int(duration_sec))
        except (TypeError, ValueError):
            duration = 10

        start = time.time()
        partial = False
        partial_reason = None
        try:
            time.sleep(duration)
        except KeyboardInterrupt:
            partial = True
            partial_reason = "listen interrupted"
        elapsed = round(time.time() - start, 3)

        if not partial and duration > 0 and elapsed < duration * 0.5:
            partial = True
            partial_reason = (
                f"listen elapsed {elapsed}s < requested {duration}s "
                "(replace with real audio device probe)"
            )

        out = {"status": "success", "action": "listen", "duration": duration, "elapsed": elapsed}
        if transcript_path:
            out["transcript_path"] = transcript_path
            try:
                size = os.path.getsize(transcript_path)
                if size == 0:
                    partial = True
                    partial_reason = "transcript file is empty"
            except OSError:
                partial = True
                partial_reason = partial_reason or f"transcript file missing: {transcript_path}"
        if partial:
            out["partial_state"] = True
            if partial_reason:
                out["partial_reason"] = partial_reason
        return out

    # ---- chat / status / leave ---------------------------------- #

    def chat(self, text):
        if not text:
            return _err("chat.text is required")
        return {"status": "success", "action": "chat", "chars": len(text)}

    def status(self, platform):
        bh_ok = BLACKHOLE.exists()
        pw_ok = PLAYWRIGHT_JOIN.exists()
        return {
            "status": "success",
            "action": "status",
            "platform": platform or "auto",
            "playwright_driver": str(PLAYWRIGHT_JOIN) if pw_ok else "missing",
            "voice_bridge": str(VOICE_BRIDGE) if VOICE_BRIDGE.exists() else "missing",
            "blackhole_router": str(BLACKHOLE) if bh_ok else "missing",
            "join_backend": self._join_backend_label(),
        }

    def leave(self):
        # leave is handled inside playwright-meet-join.mjs; this is a no-op
        # for pipelines that still call it as a separate step.
        return {"status": "success", "action": "leave", "method": "session_ended"}


def main():
    raw_payload = sys.stdin.read()
    if not raw_payload and len(sys.argv) >= 2:
        raw_payload = sys.argv[1]
    if not raw_payload:
        print(json.dumps(_err("missing input payload")))
        sys.exit(1)

    try:
        payload = json.loads(raw_payload)
    except json.JSONDecodeError as exc:
        print(json.dumps(_err(f"invalid JSON input: {exc}")))
        sys.exit(1)

    action = payload.get("action")
    params = payload.get("params") or {}
    bridge = MeetingBridge()

    try:
        if action == "join":
            result = bridge.join(
                params.get("platform", "auto"),
                url=params.get("url"),
                meeting_id=params.get("meeting_id"),
                passcode=params.get("passcode"),
                duration_sec=params.get("duration_sec", 0),
                name=params.get("name") or params.get("display_name"),
                profile_id=params.get("profile_id"),
                audio_path=params.get("audio_path"),
                screenshot_path=params.get("screenshot_path"),
                python_bin=params.get("python_bin"),
                provider=params.get("provider"),
                provider_profile_id=params.get("provider_profile_id"),
                execution_profile_id=params.get("execution_profile_id"),
                mode=params.get("mode"),
                node=params.get("node"),
                audio_bridge=params.get("audio_bridge"),
                url_policy=params.get("url_policy"),
            )
        elif action == "speak":
            result = bridge.speak(
                text=params.get("text", ""),
                platform=params.get("platform", "auto"),
                profile_id=params.get("profile_id"),
                python_bin=params.get("python_bin"),
                language=params.get("language", "ja"),
                preferred_engine=params.get("preferred_engine", "auto"),
            )
        elif action == "listen":
            result = bridge.listen(
                duration_sec=params.get("duration_sec", 10),
                transcript_path=params.get("transcript_path"),
            )
        elif action == "chat":
            result = bridge.chat(params.get("text", ""))
        elif action == "status":
            result = bridge.status(params.get("platform"))
        elif action == "leave":
            result = bridge.leave()
        else:
            result = _err(f"unknown action: {action}")
    except Exception as exc:
        result = _err(f"bridge exception: {exc}")

    print(json.dumps(result))


if __name__ == "__main__":
    main()

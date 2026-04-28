"""Kyberion Meeting Bridge.

Thin platform driver that dispatches to Zoom / Microsoft Teams / Google
Meet behind a uniform JSON contract. The TS meeting-actuator
(`libs/actuators/meeting-actuator/src/index.ts`) shells out to this
script with one JSON payload per call and parses one JSON envelope back.

Contract (input → output):

    Input:
        { "action": "join|leave|speak|listen|chat|status",
          "params": { "platform": "zoom|teams|meet|auto", "url": ..., ... } }

    Output (always one line of JSON):
        { "status": "success|error|denied",
          "platform": ...,
          "method": ...,
          "message": ...,
          "partial_state": bool,            # Ops-3: listen completeness
          "partial_reason": ...,
          "transcript_path": ...,
          ... }

Real Zoom/Teams/Meet integration is a deployment concern — vendor SDKs
plug in behind these `_join_<platform>` methods. The shared concerns
(consent gating, URL redaction, audit emission) live in the TS layer.
"""

import json
import os
import shutil
import subprocess
import sys
import time
from urllib.parse import urlparse


# Per-platform host allow-list — drives URL validation. A host that is
# not on the list returns `status: error` instead of falling through to
# `open`. That makes typos in --meeting-url fail loud.
ALLOWED_HOSTS = {
    "zoom": ("zoom.us", "zoom.com"),
    "teams": ("teams.microsoft.com", "teams.live.com"),
    "meet": ("meet.google.com",),
}


def _err(message, **extra):
    payload = {"status": "error", "message": message}
    payload.update(extra)
    return payload


def _open_url(url):
    """Open the given URL in the platform's default app.

    macOS: `open`. Linux: `xdg-open`. Windows: `start` (via cmd).
    Returns (rc, stderr).
    """
    if sys.platform == "darwin":
        cmd = ["open", url]
    elif sys.platform == "win32":
        cmd = ["cmd", "/c", "start", "", url]
    else:
        cmd = ["xdg-open", url] if shutil.which("xdg-open") else None
    if cmd is None:
        return (1, "no URL opener available on this platform")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return (proc.returncode, proc.stderr.strip())


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


class MeetingBridge:
    """Stub-but-robust drivers. Real SDKs slot in behind these methods."""

    # ---- join ---------------------------------------------------- #

    def join(self, platform, url=None, meeting_id=None, passcode=None):
        sys.stderr.write(f"[bridge] join platform={platform}\n")
        ok, reason = _validate_url(platform, url)
        if not ok:
            return _err(reason, platform=platform)
        if platform == "zoom":
            return self._join_zoom(url, meeting_id, passcode)
        if platform == "teams":
            return self._join_teams(url)
        if platform == "meet":
            return self._join_meet(url)
        if platform == "auto":
            host = urlparse(url).netloc
            if host.endswith("zoom.us"):
                return self._join_zoom(url, meeting_id, passcode)
            if host.endswith("teams.microsoft.com"):
                return self._join_teams(url)
            if host.endswith("meet.google.com"):
                return self._join_meet(url)
            return _err(f"could not auto-detect platform from host '{host}'")
        return _err(f"Unsupported platform: {platform}")

    def _join_zoom(self, url, meeting_id, passcode):
        # Prefer the zoommtg:// scheme so the desktop client receives
        # the meeting id + passcode directly rather than going through
        # a browser interstitial. Falls back to plain URL open when the
        # native scheme can't be constructed.
        zoommtg = None
        if meeting_id:
            qs = []
            if passcode:
                qs.append(f"pwd={passcode}")
            qs.append("confno=" + str(meeting_id))
            zoommtg = "zoommtg://zoom.us/join?" + "&".join(qs)
        target = zoommtg or url
        rc, stderr = _open_url(target)
        if rc != 0:
            return _err(stderr or f"zoom open failed (rc={rc})", platform="zoom")
        return {
            "status": "success",
            "platform": "zoom",
            "method": "zoommtg" if zoommtg else "browser_open",
        }

    def _join_teams(self, url):
        # The browser opens an interstitial that hands the user off to
        # the desktop client when installed. The msteams: scheme works
        # for direct hand-off too.
        target = url.replace("https://teams.microsoft.com/", "msteams:/")
        rc, stderr = _open_url(target)
        if rc != 0:
            # Fall back to the original URL — interstitial works too.
            rc2, stderr2 = _open_url(url)
            if rc2 != 0:
                return _err(stderr2 or stderr or "teams open failed", platform="teams")
            return {"status": "success", "platform": "teams", "method": "browser_open"}
        return {"status": "success", "platform": "teams", "method": "msteams"}

    def _join_meet(self, url):
        rc, stderr = _open_url(url)
        if rc != 0:
            return _err(stderr or "meet open failed", platform="meet")
        return {"status": "success", "platform": "meet", "method": "browser_open"}

    # ---- speak --------------------------------------------------- #

    def speak(self, text):
        sys.stderr.write(f"[bridge] speak chars={len(text or '')}\n")
        if not text:
            return _err("speak.text is required")
        # `say` is macOS-only; on Linux fall back to `espeak` if present
        # and on Windows fall back to PowerShell speech synthesizer.
        if sys.platform == "darwin":
            rc = subprocess.run(["say", text]).returncode
        elif sys.platform == "win32":
            ps = (
                "Add-Type -AssemblyName System.Speech;"
                "(New-Object System.Speech.Synthesis.SpeechSynthesizer)"
                f".Speak([Console]::In.ReadToEnd())"
            )
            rc = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps],
                input=text,
                text=True,
            ).returncode
        elif shutil.which("espeak"):
            rc = subprocess.run(["espeak", text]).returncode
        else:
            return _err("no speech synthesizer available (need say/espeak/powershell)")
        if rc != 0:
            return _err(f"speech synthesis failed (rc={rc})")
        return {"status": "success", "action": "speak", "chars": len(text)}

    # ---- listen -------------------------------------------------- #

    def listen(self, duration_sec=10, transcript_path=None):
        """Capture audio and (optionally) transcribe it.

        Returns `partial_state=True` whenever the listen window did not
        complete cleanly. That flag is propagated by
        `extract_action_items` onto each derived item so they
        fail-closed in execute_self / track.

        STUB heuristic — replace before real deployment.

        Today this stub uses three coarse signals to decide
        partial_state:

        1. ``KeyboardInterrupt`` (operator cancel): trustworthy.
        2. ``transcript_path`` missing or empty: trustworthy.
        3. ``elapsed < duration * 0.5`` (clock skew): **fragile.** A
           jittery `time.sleep` can fire this falsely on a contended
           system. It is good enough for a stub but it is NOT a
           reliable health signal.

        A real implementation should observe the audio device state
        directly (vendor SDK callback / rec_bridge stream errors)
        rather than infer health from wall-clock time. Tracked under
        TODO(meeting-bridge): real audio device probing — outside the
        scope of the meeting-facilitator follow-up wave.
        """
        sys.stderr.write(f"[bridge] listen duration={duration_sec}\n")
        try:
            duration = max(0, int(duration_sec))
        except (TypeError, ValueError):
            duration = 10

        # Stub capture loop — real deployments call into rec_bridge.py
        # or a vendor SDK here. We sleep, but trap KeyboardInterrupt
        # so an operator-initiated cancel still produces a structured
        # envelope (with partial_state=true).
        start = time.time()
        partial = False
        partial_reason = None
        try:
            time.sleep(duration)
        except KeyboardInterrupt:
            partial = True
            partial_reason = "listen interrupted"
        elapsed = round(time.time() - start, 3)

        # If the elapsed time is significantly less than requested, the
        # capture did not complete. Fragile heuristic — see docstring;
        # replace with vendor-SDK device telemetry before real use.
        if not partial and duration > 0 and elapsed < duration * 0.5:
            partial = True
            partial_reason = (
                f"listen elapsed {elapsed}s < requested {duration}s "
                "(stub heuristic; replace with audio-device probe)"
            )

        out = {
            "status": "success",
            "action": "listen",
            "duration": duration,
            "elapsed": elapsed,
        }
        if transcript_path:
            out["transcript_path"] = transcript_path
            # If the path was supplied but the file is missing or empty,
            # fail-closed.
            try:
                size = os.path.getsize(transcript_path)
                if size == 0:
                    partial = True
                    partial_reason = "transcript file is empty"
            except OSError:
                partial = True
                partial_reason = (
                    partial_reason or f"transcript file missing: {transcript_path}"
                )
        if partial:
            out["partial_state"] = True
            if partial_reason:
                out["partial_reason"] = partial_reason
        return out

    # ---- chat / status / leave ---------------------------------- #

    def chat(self, text):
        # Vendor SDK hook — for now we just record the chat text and
        # let the audit emit it. No platform-side delivery in stub mode.
        if not text:
            return _err("chat.text is required")
        return {"status": "success", "action": "chat", "chars": len(text)}

    def status(self, platform):
        return {
            "status": "success",
            "action": "status",
            "platform": platform or "auto",
            "bridge_mode": "stub",
        }

    def leave(self):
        return {"status": "success", "action": "leave"}


def main():
    if len(sys.argv) < 2:
        print(json.dumps(_err("missing input payload")))
        sys.exit(1)

    try:
        payload = json.loads(sys.argv[1])
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
            )
        elif action == "speak":
            result = bridge.speak(params.get("text", ""))
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
    except Exception as exc:  # pragma: no cover — defensive envelope
        result = _err(f"bridge exception: {exc}")

    print(json.dumps(result))


if __name__ == "__main__":
    main()

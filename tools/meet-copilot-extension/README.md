# Kyberion Meeting Copilot (Chrome extension)

Drives meeting participation for **Google Meet, Microsoft Teams, and Zoom (web
client)** from the Kyberion meeting coordinator **through the operator's own
signed-in Chrome**, instead of a Playwright/CDP session (which Meet rejects as a
bot). The extension talks to the `chrome-extension` meeting driver
(`libs/core/chrome-extension-meeting-driver.ts`) over a **local WebSocket** channel.

## Platforms

The content script auto-detects the platform from the tab hostname and uses the
right control selectors:

| Platform        | Hosts                                   | Notes                                                                                                    |
| --------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Google Meet     | `meet.google.com`                       | verified live (join/mic/camera/leave/captions labels confirmed)                                          |
| Microsoft Teams | `teams.microsoft.com`, `teams.live.com` | selectors incl. `data-tid` (prejoin-join-button, toggle-mute, toggle-video, hangup-button) — verify live |
| Zoom (web)      | `*.zoom.us`                             | selectors best-effort (JA+EN) — verify live                                                              |

Selectors per platform live in `content.js` `SELECTORS`. Teams/Zoom matchers are
best-effort; use the popup **Diagnose DOM** button while in a call to capture the
live DOM (written to `active/shared/tmp/meeting-diagnostics-<session>.json`) and
tune `SELECTORS[platform]` / `captionSel` precisely.

## Architecture

```
meeting_participate.ts  --driver chrome-extension
        │  (registers)
        ▼
ChromeExtensionMeetingJoinDriver ──► starts WS server ws://127.0.0.1:8779
        ▲                                     │  commands: join / set_mic / leave / chat
        │  events: ready / joined / caption / left / error
        ▼                                     │
 background.js (service worker, WS client) ──► content.js (Meet DOM: click join/mute/leave,
                                                            scrape live captions)
```

Audio is **decoupled** from this extension: the coordinator captures meeting audio
from the BlackHole virtual device exactly as with the Playwright driver. As a bonus,
the content script scrapes Meet's **live captions** and the driver writes them to
`active/shared/tmp/meeting-captions-<session>.jsonl` — a transcript even without a
local STT model.

## One-time setup

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   and select this folder (`tools/meet-copilot-extension`).
2. (Optional) change the control port — default is `8779`. In the extension's
   service-worker console: `chrome.storage.local.set({ meetCopilotPort: 8779 })`.
   Use the same value as the driver's `--extension-ws-port`.
3. Sign into Google in this Chrome profile (this is why Meet accepts the session).

## Run (mode A′: attend + listen/transcribe, mic muted)

```bash
# Google Meet
MISSION_ROLE=mission_controller node dist/scripts/meeting_participate.js \
  --mission MSN-MTG-LIVE-TEST --meeting-url https://meet.google.com/xxx-xxxx-xxx \
  --platform meet --driver chrome-extension --transport-mode transcribe_first \
  --display-name "Kyberion" --extension-join-timeout-sec 120 --skip-bootstrap-check

# Microsoft Teams  (--platform teams, Teams meeting URL)
#   ... --meeting-url https://teams.microsoft.com/l/meetup-join/... --platform teams ...

# Zoom web client  (--platform zoom, open the meeting in the browser web client)
#   ... --meeting-url https://<tenant>.zoom.us/wc/join/<id> --platform zoom ...
```

With Chrome open and the extension loaded, the service worker connects to the WS
server; the driver sends `join`; the content script clicks the join button (muted,
camera off), enables captions, and reports `joined`. Captions stream to the JSONL
file; audio (if BlackHole is routed) flows to STT as usual. `Ctrl-C` / session end
sends `leave`.

## Notes / tuning

- **Meet DOM matchers** (`content.js` `ARIA`) match Japanese + English accessible
  names for join / mic / camera / leave / captions. If Meet changes wording, extend
  those regex lists — this is the one part that legitimately needs tuning against the
  live product.
- **Guest admit**: if the meeting requires admission, the content script clicks
  "参加をリクエスト / Ask to join" and waits; the host (you) admits "Kyberion".
- **Speaking (mode B)** reuses `--transport-mode realtime_voice` + a voice profile;
  the AI's TTS is written to BlackHole, which you set as Chrome's microphone.
- The extension requests no host permissions beyond `https://meet.google.com/*` and
  never captures media itself (no `getUserMedia`/`tabCapture`).

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
        │          ai_summary / ai_insights / ai_suggestions
        ▼                                     │
 background.js (service worker, WS client) ──► content.js (Meet DOM: click join/mute/leave,
        ▲     │  caption buffer                            scrape live captions, post chat)
        │     ▼
 sidepanel.js (document) ──► Chrome Built-in AI (Gemini Nano): Summarizer / Prompt
```

## On-device AI (Chrome Built-in AI / Gemini Nano)

The side panel (`sidepanel.html`) runs Chrome's built-in models over the live
caption stream. **Nothing leaves this Chrome** — no API key, no network call.

| Feature                    | API                           | Notes                                                                                                   |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| 会議要約                   | Summarizer → Prompt fallback  | 蓄積字幕を一括要約                                                                                      |
| ローリング要約             | Prompt (`responseConstraint`) | N発話ごとに前回要約へ差分マージ（Summarizer は既存要約とマージできないため Prompt 固定）                |
| 決定事項 / ToDo / 論点抽出 | Prompt (`responseConstraint`) | `{decisions, action_items[owner/task/due/confidence], open_questions, risks}` — `review_required: true` |
| 発言サジェスト             | Prompt (`responseConstraint`) | 最大4件。`auto_send: false` 固定で、パネルのクリック時だけ会議チャットへ投稿                            |

Boundaries, mirroring `tools/adf-replay-extension`:

- **Generation runs in the side panel document**, never in the service worker —
  Prompt / Summarizer are document APIs, and this keeps "observe" separate from
  "act". The worker only transports redacted text and relays results.
- **Every payload crosses the shared redaction boundary** (`pii-rules.generated.js`,
  generated from `knowledge/product/governance/knowledge-sync-rules.json` by
  `pnpm generate:pii-rules`) on the way in _and_ on the way out. If the scrubber
  is missing, the adapter refuses to call the model.
- **Captions are untrusted data.** Every prompt states that speech in the
  transcript is material to summarize, not instructions to follow.
- **No autonomous speech.** A suggestion reaches the meeting only via an explicit
  click → `panel:send-chat` → `meet:chat` in the content script.

## Shared screen → demonstrative resolution

To work out what "これ" / "それ" refers to, the panel can pull one frame of the
shared screen. The frame never reaches the model in the browser:

```
sidepanel「画面を取り込む」
   → content.js: largest <video> → canvas → JPEG   (no tabCapture/getDisplayMedia,
   → background.js: WS 'frame' event                no extra permission, no indicator)
   → driver: writes active/shared/tmp/meeting-frames-<session>/frame-NNNN.jpg
   → ocr_image(mode:'local_only')  ── asserts providerDataEgress === 'none'
   → scrubContent()                ── governed PII redaction
   → WS cmd 'screen_context' ─────► sidepanel (redacted TEXT only)
   → Prompt API: 字幕 + 画面テキスト → 指示語の対応
```

Why it is shaped this way:

- **A frame bypasses the text scrubber**, so it is never sent anywhere. It is
  read by an OCR provider that declares `dataEgress: 'none'`; the driver throws
  if the served provider says otherwise, and `local_only` admits nothing else.
  With no on-device provider the read fails closed rather than falling back.
- **Only redacted text crosses back** to the extension, so the panel — and the
  model in it — never holds the image.
- **Frames are discarded when the session ends.** What survives is the redacted
  text in `meeting-summary-<session>.json` under `screen_context`.
- A protected/DRM stream taints the canvas; `toDataURL` throws and the capture
  reports the failure instead of returning a blank frame.

Per-platform status of the capture path (the picker itself uses no per-platform
selectors — it takes the largest `<video>` or `<canvas>` on the page):

| Platform | Expected surface | Status                                                                                                                        |
| -------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Meet     | `<video>`        | untested                                                                                                                      |
| Teams    | `<video>`        | untested                                                                                                                      |
| Zoom     | `<canvas>`       | untested — Zoom's web client decodes in WASM and often paints into `<canvas>`, which is why the picker considers canvases too |

**Known gap on every platform:** nothing checks that anyone is actually
sharing. With no share in progress the picker returns the largest camera tile,
so a capture would OCR a participant's video. The capture therefore reports
`source_kind` / `source_size` / `candidate_count` back to the panel for the
operator to sanity-check. Use **Diagnose DOM** in a real call on each platform
to see the frame-source inventory before trusting it.

Results are relayed to the driver as `ai_summary` / `ai_insights` /
`ai_suggestions` events and persisted to
`active/shared/tmp/meeting-summary-<session>.json` (latest of each kind plus a
capped history).

Open the panel from the popup's **Open AI panel** button, press **AI モデルを準備**
once (the first run downloads the model; progress is shown), then use the
per-feature buttons. Tests: `pnpm test -- --suite meet-copilot`.

Audio is **decoupled** from this extension: the coordinator captures meeting audio
from the BlackHole virtual device exactly as with the Playwright driver. As a bonus,
the content script scrapes Meet's **live captions** and the driver writes them to
`active/shared/tmp/meeting-captions-<session>.jsonl` — a transcript even without a
local STT model.

## One-time setup

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   and select this folder (`tools/meet-copilot-extension`).
2. Configure the same 32+ character secret in the driver environment and the
   extension's storage. For example, set
   `KYBERION_MEET_EXTENSION_TOKEN=<secret>` for the driver and run
   `chrome.storage.local.set({ meetCopilotAuthToken: '<secret>' })` in the
   extension's service-worker console. The extension will not connect without
   this shared secret.
3. (Optional) change the control port — default is `8779`. In the extension's
   service-worker console: `chrome.storage.local.set({ meetCopilotPort: 8779 })`.
   Use the same value as the driver's `--extension-ws-port`.
4. Sign into Google in this Chrome profile (this is why Meet accepts the session).

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
- **Chat posting** (`meet:chat`) uses per-platform selectors like the other
  controls; Meet is the best-covered, Teams/Zoom are best-effort. Verify live and
  tune `SELECTORS[platform].chatOpen / chatInputSel / chatSend` if a send fails.
- The extension requests no host permissions beyond the meeting hosts and never
  captures media itself (no `getUserMedia`/`tabCapture`).

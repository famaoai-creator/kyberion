---
title: AI-Run Meetings Use Case
category: Architecture
tags: [meeting, facilitation, action-items, voice, use-case]
importance: 8
last_updated: 2026-04-27
---

# AI-Run Meetings — Use Case

A Kyberion deployment can stand in for the operator inside an online
meeting (Zoom / Teams / Google Meet), facilitate the conversation,
extract action items, complete its own slice autonomously, and track
the rest until completion. This document describes the user-visible
flow, the actuators / pipelines that compose it, and the operational
guardrails.

Surface requests for this workflow map to the `meeting-operations` intent.

## 1. Operator experience

```
operator $ pnpm meeting:run \
  --mission MSN-MTG-2026-Q2-WEEKLY \
  --meeting-url "https://example.zoom.us/j/9999999999" \
  --platform zoom \
  --persona "Operator" \
  --listen-sec 1800 \
  --agenda "Status|Risks|Action items" \
  --attendees @attendees.json \
  --language ja
```

The orchestrator drives three logical stages:

1. **Facilitate** — opens the agenda, joins the meeting, listens,
   extracts action items into the mission's append-only store.
2. **Execute self** — for each item where `assignee.kind = operator_self`,
   the agent dispatches a small task plan via `delegateTask` and marks
   the item completed (or blocked, with the failure reason).
3. **Track others** — for each `team_member` item, the agent generates
   a per-recipient reminder message, records it on the action item,
   and emits a `meeting.<verb>` audit event.

Before stage 1 starts, Kyberion now compiles a meeting brief from the
requested purpose and the stored `meeting-operations-profile`. That
brief decides the initial role hint, the authority boundary, and the
first clarification questions when the meeting request is underspecified.
The same brief now also carries a deterministic `environment` plan so
audio, camera, screen-sharing, STT, TTS, and voice-consent prerequisites
are decided in one place instead of by ad hoc branching later.

After every run, a summary is printed:

```
📋 Mission MSN-MTG-2026-Q2-WEEKLY action-item summary:
   total recorded: 7
   operator_self pending: 0
   team_member pending: 4
   🟢 [completed] AI-MTG-1-M1: Send revised proposal to compliance (assignee=Operator)
   🟡 [pending]   AI-MTG-2-M2: Confirm Q3 budget with finance (assignee=Alice)
   ...
```

## 2. Architecture

```
┌─ scripts/meeting_orchestrator.ts ─────────────────────────────────┐
│                                                                  │
│   Stage 1: Facilitate                                            │
│   ─────────────────────                                          │
│   pipelines/meeting-facilitation-workflow.json                   │
│     • meeting-actuator (join → listen → leave)                   │
│     • wisdom:generate_facilitation_script                        │
│     • wisdom:extract_action_items  ── action-item-store          │
│                                                                  │
│   Stage 2: Execute Self                                          │
│   ─────────────────────                                          │
│   pipelines/action-item-execute-self.json                        │
│     • wisdom:execute_self_action_items                           │
│         (for each operator_self item:                            │
│            in_progress → delegateTask → completed | blocked)     │
│                                                                  │
│   Stage 3: Track Others                                          │
│   ──────────────────────                                         │
│   pipelines/action-item-tracking.json                            │
│     • wisdom:track_pending_action_items                          │
│         (for each team_member item: generate reminder → log)     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### New components introduced

| Component                                      | Purpose                                                                                                                                                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas/action-item.schema.json`              | Canonical action-item shape (used by validators and AJV-based contract checks)                                                                                                                                                    |
| `libs/core/action-item-store.ts`               | Append-only JSONL store (`action-items.jsonl`) under the mission's evidence directory; provides `recordActionItem`, `updateActionItemStatus`, `appendReminder`, `listActionItems`, `listOperatorSelfPending`, `listOthersPending` |
| `wisdom:extract_action_items`                  | LLM-driven transcript → structured items + persistence                                                                                                                                                                            |
| `wisdom:generate_facilitation_script`          | Short utterances for opening / transition / wrap-up                                                                                                                                                                               |
| `wisdom:generate_reminder_message`             | Per-item reminder draft (channel + text)                                                                                                                                                                                          |
| `wisdom:execute_self_action_items`             | Iterate `operator_self` pending items; dispatch via `delegateTask`; transition to completed / blocked                                                                                                                             |
| `wisdom:track_pending_action_items`            | Iterate `team_member` pending items; emit reminders; record into the store                                                                                                                                                        |
| `meeting-actuator` (existing, hardened)        | `join / leave / speak / listen / chat / status` with **voice consent gate** on `speak`, `meeting.<verb>` audit emission, and `join_backend` tagging for the internal browser backend                                              |
| `meeting-browser-driver` (internal)            | Playwright join backend behind `meeting-actuator`; owns web-meeting entry and live-caption capture (`transcriptInput`) into `[mm:ss] Speaker: text` transcript files for `meeting:normalize_transcript`                           |
| `pipelines/meeting-facilitation-workflow.json` | Stage 1 wiring                                                                                                                                                                                                                    |
| `pipelines/action-item-execute-self.json`      | Stage 2 wiring                                                                                                                                                                                                                    |
| `pipelines/action-item-tracking.json`          | Stage 3 wiring (cron-able)                                                                                                                                                                                                        |
| `scripts/meeting_orchestrator.ts`              | Stage runner + summary                                                                                                                                                                                                            |

## 3. Guardrails

The use case implies authority that the operator must explicitly delegate:

- **Voice consent (`meeting-actuator`)** — `speak()` is refused unless
  the active mission's evidence directory contains a `voice-consent.json`
  whose `consent: 'granted'` is unambiguous. Without that file, the
  agent can `join`, `listen`, `chat`, and `leave`, but cannot speak in
  the operator's voice. This is the load-bearing check; never bypass.
- **Participation consent (`meeting:participate`)** — the live
  participation coordinator checks the same `voice-consent.json` before
  capture starts and re-checks before TTS speech. The capture path is
  the browser join driver plus `AudioBus`; missing, revoked, expired,
  malformed, wrong-mission, or wrong-tenant consent fails closed before
  audio capture or speech proceeds.
- **Dry-run before real meeting** — use
  `pnpm kyberion preview pipelines/meeting-proxy-workflow.json` and
  `pnpm test -- --suite meeting-dry-run` to validate workflow structure,
  consent gates, host allowlist, and redaction without opening a call.
- **Voice profile registration** — the synthesized voice itself must be
  a `voice-profile-registry.json` entry whose source samples were
  recorded by the operator (see `pipelines/voice-recording-session.json`).
  A clone made from samples that do not belong to the operator is a
  separate, refused workflow.
- **Action items are reminders, not authority** — items assigned to
  others surface a reminder, never an instruction. Recipients keep
  agency.
- **Audit emission** — every `join / leave / speak / listen / chat`
  call lands as a `meeting.<verb>` audit event with the redacted
  meeting target, platform, duration / character count, and
  `tenant_slug` when applicable.
- **Tenant scope** — when `KYBERION_TENANT` is set on the orchestrator,
  the mission inherits it; per-tenant SIEMs receive only their own
  meeting events via `TenantFilteringAuditForwarder`.

## 4. Failure modes

| Failure                             | Detection                                                                   | Response                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Voice consent missing on `speak`    | Returns `status: denied`; emits `meeting.speak_denied`                      | Operator records consent; rerun                                                                     |
| Bridge cannot join the meeting      | Returns `status: error`; emits `meeting.join_failed`                        | Investigate the meeting browser driver / platform; rerun with `--skip-facilitate` after manual join |
| LLM extracts zero action items      | `action_item_count = 0` in pipeline ctx; orchestrator summary shows total=0 | Re-run with longer `listen_duration_sec`; verify the transcript file is non-empty                   |
| `delegateTask` fails on a self item | Item transitions to `blocked` with the error in `result_summary`            | Operator unblocks manually or re-runs `pipelines/action-item-execute-self.json`                     |
| Reminder dispatch sends duplicates  | `appendReminder` is idempotent on `(sent_at, channel)`                      | No remediation needed                                                                               |
| Live consent missing before capture | `meeting_participation.recording_denied` trace/audit event                  | Grant mission-scoped consent or use dry-run only                                                    |
| Consent revoked before TTS speech   | `meeting_participation.speak_denied` trace/audit event                      | Re-grant consent intentionally or remain silent                                                     |

## 5. Cron / scheduling

Stage 3 (tracking) is the obvious cron candidate:

```
# /etc/cron.d/kyberion-meeting-tracking — daily at 09:00 JST
0 0 * * * kyberion cd /opt/kyberion && \
  pnpm pipeline --input pipelines/action-item-tracking.json \
    --context '{"mission_id":"MSN-MTG-2026-Q2-WEEKLY","tone":"friendly","language":"ja"}'
```

Stage 1 is operator-triggered (a meeting is happening _now_). Stage 2
runs immediately after Stage 1 inside `meeting_orchestrator.ts` so the
operator's slice is dispatched while the context is fresh.

## 6. Testing

Unit / contract tests:

- `libs/core/action-item-store.test.ts` (8 cases) — record / update /
  reminders / list filters
- `libs/actuators/meeting-actuator/src/index.test.ts` (9 cases) —
  schema + voice-consent gate
- `libs/actuators/wisdom-actuator/src/decision-ops.test.ts` —
  rubric / convergence (existing suites; the LLM-dependent
  meeting-facilitation ops are integration-tested via the orchestrator
  smoke run when a real backend is configured)

Smoke run (with `claude-cli` backend):

```bash
KYBERION_REASONING_BACKEND=claude-cli \
  pnpm meeting:run \
    --mission MSN-DRY-RUN-001 \
    --meeting-url "https://example.zoom.us/j/9999999999" \
    --platform auto \
    --listen-sec 5 \
    --skip-tracking
```

## 6b. Live-join setup (browser-playwright + captions)

Capture is the platforms' own live captions scraped from the DOM —
no audio loopback, headless-capable. Per-run flow:
`meeting:join` (or `listen` with a `url`) → pre-join UI → captions
toggle (best effort) → poll caption regions every 3s →
`[mm:ss] Speaker: text` transcript file → existing
`meeting-followup` pipeline. Zero cues ⇒ `partial_state: true`
with `partial_reason`, never a silent empty transcript.

Join backends (`meeting:join` / `listen` param `join_backend`):

- `playwright` (default) — headless browser via
  `libs/actuators/meeting-browser-driver`. Best for unattended
  Chronos runs. Risks: bot detection, lobby admission, selector
  drift (override via `in_meeting_selectors_override` in
  `libs/actuators/meeting-browser-driver/src/selectors.ts`).
- `chrome-extension` — the operator's own signed-in Chrome through
  `tools/meet-copilot-extension` over `ws://127.0.0.1:8779`.
  No bot rejection, no cookie juggling. Requires: extension loaded
  in Chrome, a Meet/Teams/Zoom tab open, and
  `KYBERION_MEET_EXTENSION_TOKEN` (32+ chars, same value as the
  extension's `meetCopilotAuthToken` in Chrome storage).
  Missing extension/token fails closed with setup guidance.
- `auto` — try the extension with a 20s connect timeout, fall back
  to Playwright. Good default when the operator may or may not be
  at their desk.

- **Login**: guest links that admit by name work with
  `display_name` only. Host-auth meetings need a signed-in session:
  launch once with a persistent profile
  (`user_data_dir` + `profile_directory`, or `account_slug` cookie
  jar), sign in manually, later runs reuse it. `headed: true`
  runs a visible Chromium for debugging selectors.
- **Admission**: guest joins that need host approval wait at most
  `step_timeout_ms` (≥30s) for the join button; lobby timeout
  surfaces as `meeting.join_failed`.
- **Captions must exist**: host-disabled captions / transcription
  means nothing to scrape — the transcript stays empty and the
  run reports `partial_state`.
- **Out of scope**: bot-detection evasion, in-meeting chat send,
  system-audio recording (use `voice:transcribe` on recordings
  instead), vendor bot SDKs.

## 6c. Declared meeting gestures (kyberion-specified operations)

Beyond observe-and-summarize, the extension accepts declared verbs
from the driver over the WS control channel
(`tools/meet-copilot-extension/background.js` `CONTROL_COMMANDS`):

| Verb                                         | Content action          | Notes                                                                                                                           |
| -------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `join / leave / set_mic / set_camera / chat` | pre-existing            | —                                                                                                                               |
| `raise_hand`                                 | toggle-aware hand raise | no-op when already raised; ack event `raised_hand`                                                                              |
| `admit [name]`                               | waiting-room admission  | admit-all when offered, else visible buttons; name narrows by row text (best effort); ack event `admitted` with count for audit |

Driver surface: `MeetingSession.raiseHand()` / `admit(name?)`
(`libs/core/meeting-session-types.ts`, optional — Playwright
sessions omit them). `meeting:join` accepts `raise_hand: true`
(join → raise → capture → leave) for listen-only presence.

Guardrails:

- `raise_hand` is safe to automate (visible, reversible).
- `admit` exercises **host authority** — treat like an approval
  gate: coordinator policy must explicitly allow it per mission,
  and every admission lands in the audit chain with the count.
- Verbs are allowlisted at both ends (background `CONTROL_COMMANDS`
  - content message switch); anything else is dropped, never
    executed. No free-form element clicking from the driver side —
    general browser operation stays in `browser-actuator`.
- Interactive mid-meeting verbs: `meeting:participate` reads
  `status | raise-hand | admit [name] | chat <text> | leave | help`
  from stdin while the coordinator owns the session
  (`scripts/meeting_commands.ts`; TTY by default,
  `--interactive-commands=false` to disable). `admit` additionally
  requires `--allow-admit` per run and every verb lands in the
  trace (`meeting_participation.*`). Coordinator exposes the live
  session via `MeetingParticipationOptions.onSession`.

## 8. Avatar presence (hear / teach / appear)

Guided dialogue ops (`libs/actuators/meeting-actuator/src/meeting-guided-dialogue.ts`):

- `meeting:hearing_session {topic, counterparty_label?, context?, answers?}` —
  customer requirements hearing. Without `answers` it returns an
  ordered question script; with answers it extracts `{requirements,
open_questions, next_questions}`. Re-invoke with accumulated
  answers for multi-turn hearings.
- `meeting:tutor_session {material|material_path, learner_label?, goal?, answers?}` —
  gentle teaching. Without `answers` it returns sectioned
  explanations with comprehension checks; with answers it grades
  kindly (`struggling|progressing|solid`) and fills gaps.

Talking-avatar video (`voice:render_talking_avatar`):

- Inputs: `portrait_path` (PNG/JPG; or `avatar_name` from the
  presence registry) + `text` (offline `say` TTS on macOS) or
  `audio_path`. Output: 720p H264+AAC MP4 with Ken Burns drift,
  volume-driven mouth, and periodic blinks (VTuber-lite,
  PIL+numpy+ffmpeg only — no model download).
- Face geometry (`mouth_x/y/w`, `eyes_y`) is tunable per avatar;
  illustrated front-facing portraits work best.

Camera output (`voice:output_to_virtual_camera`):

- Thin dispatcher over the `camera-output-bridge` seam
  (`libs/core/camera-output-bridge.ts`): capability-declared,
  probe-gated, named backends — the same adopter pattern as the
  voice-side bridges. `backend` selects explicitly (`obs-virtual-cam`
  today; `auto` takes the first probed-available backend and never
  silently stubs). New camera solutions (v4l2 loopback, …) register
  a backend instead of changing the op.
- OBS backend (`obs-virtual-cam`,
  `libs/core/obs-virtual-camera-output.ts`): obs-websocket v5 over
  the `ws` package only — ensures scene + looping `ffmpeg_source`,
  switches to it, starts the virtual camera.
  `KYBERION_OBS_WS_PASSWORD` must match the OBS server password.
- Setup: install OBS Studio → start Virtual Camera → enable
  Settings → WebSocket Server → set Server Password → select
  "OBS Virtual Camera" as the Meet/Teams/Zoom camera (once).
  Without OBS every call fails closed with setup guidance.

## 7. Reference

- [`schemas/action-item.schema.json`](../schemas/action-item.schema.json)
- [`libs/core/action-item-store.ts`](libs/core/action-item-store.ts)
- [`libs/actuators/meeting-actuator/`](libs/actuators/meeting-actuator)
- [`pipelines/meeting-facilitation-workflow.json`](pipelines/meeting-facilitation-workflow.json)
- [`pipelines/action-item-execute-self.json`](../pipeline-templates/action-item-execute-self.json)
- [`pipelines/action-item-tracking.json`](../pipeline-templates/action-item-tracking.json)
- [`scripts/meeting_orchestrator.ts`](scripts/meeting_orchestrator.ts)
- [`knowledge/product/agents/meeting-proxy.agent.md`](knowledge/product/agents/meeting-proxy.agent.md) — agent template
- [`kyberion-intent-catalog.md`](knowledge/product/architecture/kyberion-intent-catalog.md) §3.6 — adjacent platform-extension intents

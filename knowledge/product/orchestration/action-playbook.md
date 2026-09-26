---
title: Action Playbook (converse / hands / move — which executor for which target)
category: Orchestration
tags:
  [
    orchestration,
    action,
    computer-use,
    browser-actuator,
    system-actuator,
    terminal-actuator,
    presence,
    voice,
    tts,
    navigation,
  ]
importance: 8
author: Ecosystem Architect
last_updated: 2026-09-25
role_affinity: [ecosystem_architect, mission_controller, implementer, operator]
phase_affinity: [alignment, execution]
---

# Action Playbook

The counterpart of the [perception playbook](./perception-playbook.md): when an
agent has to **act** — say something, operate a screen or a terminal, go somewhere —
which layer to use. Japanese: [action-playbook.ja.md](./action-playbook.ja.md).
Which capabilities still lack a single verb (authoring, image / video generation, the
memory axis) is tracked in
[capability-verb-inventory.md](./capability-verb-inventory.md).

Unlike perception there is no single command per action. Actions are split **by
target** on purpose (a web page, a desktop app and a terminal need different
executors and different approval gates). The rule is: pick the target, then the
narrowest rung of the ladder that can do it.

## 1. Pick the narrowest rung (native op ladder)

1. An exact deterministic op or existing pipeline (`pipelines/`).
2. An existing actuator op or governed CLI (`pnpm kyberion …`).
3. A browser / session operation.
4. Desktop GUI actions — only when no API or CLI can express the task.

Source: [native-op-ladder.md](./native-op-ladder.md). Raising the rung needs a reason.

## 2. Hands (手を動かす) — executor by target

All three speak the same `computer_interaction` contract
(`knowledge/product/schemas/computer-interaction.schema.json`, `target.executor`).
They are **not duplicates**; their action sets do not overlap.

| Target                   | Executor                                                        | Typical actions                                                                                           |
| ------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Web page                 | `browser-actuator` (Playwright), `pnpm kyberion browser run`    | `goto`, snapshot → `click_ref` / `fill_ref` / `fill_secret_ref`, scroll, `extract_text_ref`, `screenshot` |
| Desktop app / OS         | `system-actuator` `computer_interaction` (os-automation-bridge) | `activate_application`, click / move, focused-input type / submit, tabs by title/url, `open_path`         |
| Terminal / shell session | `terminal-actuator` (PTY)                                       | spawn / write / poll / kill session, `shell_command`                                                      |
| Files / code             | `file` / `code` pipeline ops, or Write / Edit                   | `write_file`, `regex_replace`                                                                             |
| Mobile device            | `android-actuator` / `ios-actuator`                             | `launch_app`, `open_deep_link`, taps, `capture_screen`                                                    |
| A document to hand over  | `pnpm kyberion write <brief.json> --out <file>`                 | pptx / docx / xlsx / pdf from a semantic brief (`media:generate_document`); the inverse of `read`         |

- **Screen capture** is `system:screenshot` / `system:record_screen` — they apply
  screen-frame redaction. The `media-generation` / `vision` capture ops only forward
  there. Page captures: `browser:screenshot`.
- Details: [browser-automation-best-practices.md](./browser-automation-best-practices.md),
  [computer-use-runtime-model.md](../architecture/computer-use-runtime-model.md),
  [os-automation-bridge-model.md](../architecture/os-automation-bridge-model.md).

## 3. Move (移動する) — part of hands

There is no separate movement layer. "Moving" is a focus change inside a hands
executor: `browser:goto` (a page), `system` `activate_application` / `open_path` /
`activate_tab_by_url` (a desktop app, file or tab), `ios` / `android` `launch_app` /
`open_deep_link` (an app screen). Physical movement (robotics, GPS) does not exist.

## 4. Converse (会話する)

| Need                                     | Use                                                                                                                                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Answer a person on any text channel      | the surface conversation seam `runSurfaceMessageConversation` (`libs/core/surface-runtime-orchestrator.ts`) — already used by `ask`, Slack / Telegram / Discord / iMessage satellites, voice-hub, concierge, Chronos |
| Ask Kyberion from the terminal           | `pnpm kyberion ask "<text>"`                                                                                                                                                                                         |
| Send a message out                       | `presence:dispatch` with a channel prefix (`slack:`, `telegram:` …)                                                                                                                                                  |
| Say something aloud / make an audio file | `pnpm kyberion speak "<text>" [--out <file>]` (inverse of `listen`); in pipelines `voice:generate_voice` / `voice:speak_local`                                                                                       |
| Real-time voice dialogue                 | `pnpm kyberion voice conversation-turn` — see [voice-interface-protocol.md](./voice-interface-protocol.md)                                                                                                           |
| Agent ↔ agent                            | Co-Session / Peer Messaging — [agent-communication-layer-model.md](../architecture/agent-communication-layer-model.md)                                                                                               |

Do not add a new channel by wiring a reasoning backend directly — register it
behind the surface seam so tenant scope, audit and approval apply.

## 5. Traps

1. **Do not automate the GUI by hand.** `osascript`, `cliclick`, `xdotool`,
   `screencapture`, bare `say`, pyautogui / pynput and ad-hoc Playwright scripts are
   denied by the shell policy (`gui-hand-automation`) and point back here. The
   governed bridges in `libs/core` use them internally with redaction and approval.
2. **Secrets go through `fill_secret_ref`**, never typed as plain text.
3. **Risky actions wait for approval** (delete, send, purchase). Do not work around
   an approval wait by switching executors.
4. **Voice conversation is the one path outside the surface seam** today
   (`realtime-voice-conversation.ts` calls the reasoning backend directly). Keep that
   in mind when auditing what a voice session could reach.

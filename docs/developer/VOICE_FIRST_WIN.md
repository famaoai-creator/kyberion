---
title: Voice First Win (Phase A-5)
category: Developer
tags: [voice, first-win, tier-0, presence-surface]
importance: 9
last_updated: 2026-05-07
---

# Voice First Win

How the "Hello Kyberion" voice demo is wired together. Phase A-5 of `docs/PRODUCTIZATION_ROADMAP.md`.

The promise: **clone → 5 minutes → speak to Kyberion, hear it speak back, with no API key and no extra install on macOS / Windows.**

## Three tiers

| Tier | STT (input) | TTS (output) | External deps |
|---|---|---|---|
| **0** (default first win) | Browser Web Speech API | OS native (`say` / `espeak` / SAPI) | None |
| 1 (opt-in upgrade) | Anthropic Voice / OpenAI Realtime | same | API key |
| 2 (further opt-in) | Whisper (local) | Style-Bert-VITS2 (local) | python + GPU |

Tier 0 is the first-win path. This document is about wiring tier 0.

## Components

```
┌─────────────────────────────┐
│ presence-studio (browser)   │  Web Speech API: mic → text
│   surface route /voice-hello│
└──────────┬──────────────────┘
           │ websocket message
           ▼
┌─────────────────────────────┐
│ voice-hub (satellites/)     │  Routes between browser surface
│                             │  and core pipelines
└──────────┬──────────────────┘
           │ topic publish
           ▼
┌─────────────────────────────┐
│ pipelines/voice-hello.json  │  ADF pipeline: greet → wait_for
│                             │  → resolve_intent → execute → speak
└──────────┬──────────────────┘
           │ system:native_tts_speak
           ▼
┌─────────────────────────────┐
│ libs/core/native-tts.ts     │  Spawns say / espeak / PowerShell
└─────────────────────────────┘
```

## What's implemented (Phase A-5 partial)

- [x] `libs/core/native-tts.ts` — OS native TTS wrapper (`speak`, `probeNativeTts`, `hasBuiltInTts`).
- [x] `libs/core/native-tts.test.ts` — unit tests for command building, control char sanitization.
- [x] Exported via `@agent/core` as `nativeTtsSpeak` / `probeNativeTts` / etc.
- [x] `pipelines/voice-hello.json` — the tier-0 first-win ADF.
- [x] `system:native_tts_speak` — system actuator wiring from the voice pipeline to `libs/core/native-tts.ts`.
- [x] `system:check_native_tts` — preflight probe that calls `probeNativeTts()` and exports its status.
- [x] README / Quickstart now point at the first-win smoke commands.

## What's NOT implemented yet

- [ ] **`presence-studio` voice-hello route** — the browser frontend that uses Web Speech API for input.
- [ ] **`voice-hub` topic** — `voice-hello.user-spoke` for the bridge between surface and pipeline.
- [ ] **`wait_for` op** in pipeline-engine that suspends the pipeline until a topic is published or a fallback fires.
- [ ] **`pnpm doctor` integration** — surface tier-0 voice readiness as a "must" check.

These are the concrete next tasks for Phase A-5 to land end-to-end. Each is small (~30 min – 2 hr) but they cross multiple components, so they're listed here as the punchlist.

## How a future tier upgrade works

```bash
# Tier 0 → Tier 1 (cloud voice)
pnpm voice:upgrade-cloud
# Sets KYBERION_VOICE_TIER=1, copies a customer-specific voice profile,
# verifies API key. The pipeline switches to anthropic-voice-bridge for input.

# Tier 1 → Tier 2 (local Style-Bert-VITS2)
pnpm voice:upgrade-local
# Pulls model files (1.2 GB), starts local server, verifies.
```

The upgrade commands are implemented as configurators and validate prerequisites.
What is still pending is full end-to-end runtime switching for the voice surface;
see Phase A-5.8 in the roadmap.

## Why tier 0 matters

OSS first impression is decided in the first 60 seconds. Forcing API keys / install / login at the door is the highest-leverage way to lose users we never hear from. Tier 0 means the demo works for anyone who clones the repo — and they can decide to pay later.

## Related

- [`docs/PRODUCTIZATION_ROADMAP.md` §10 付録 A](../PRODUCTIZATION_ROADMAP.md) — full voice first-win specification.
- [`libs/core/native-tts.ts`](../../libs/core/native-tts.ts) — TTS wrapper.
- [`pipelines/voice-hello.json`](../../pipelines/voice-hello.json) — ADF.

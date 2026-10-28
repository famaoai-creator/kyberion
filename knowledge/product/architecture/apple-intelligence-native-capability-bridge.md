---
title: Apple Intelligence Native Capability Bridge
kind: architecture
scope: repository
authority: reference
phase: [alignment, execution]
tags: [apple-intelligence, macos, vision, voice, computer-use, governance]
owner: ecosystem_architect
last_updated: 2026-10-29
---

# Apple Intelligence Native Capability Bridge

## Goal

Kyberion should be able to use Apple Intelligence as a local macOS capability layer without turning it into a hidden special case in the core orchestration model.

The right shape is:

- local-first when the device supports it
- governed through a native capability bridge
- recorded in trace / receipts
- replaceable by Kyberion-local or cloud providers when Apple-specific features are unavailable

## Why This Fits Kyberion

Apple Intelligence is strongest where Kyberion already needs a host-native front door:

- image understanding and visual search
- voice input and voice output
- action execution inside supported apps
- screenshot-based observation on Mac
- user-visible workflows that should stay on-device when possible

Apple's public developer framing is aligned with that direction:

- the Foundation Models framework and App Intents can be used by apps
- on-device models are available to app code
- the features work offline
- request cost is not billed per request

That makes Apple Intelligence a good fit for a Kyberion-native bridge rather than a provider-neutral ADF primitive.

## Capability Map

Treat Apple Intelligence as a set of capabilities, not a monolith:

- `vision-understanding`
  - screenshot review
  - image description
  - image-to-action handoff
- `voice-input`
  - speech capture
  - dictation-like command intake
- `voice-output`
  - spoken response / narration
  - short confirmations
- `intent-action`
  - App Intents
  - Shortcuts
  - OS-approved app actions
- `computer-observation`
  - screen-level context on Mac
  - visually grounded follow-up actions

## What It Should Not Be

Apple Intelligence should not be treated as:

- a generic cloud API replacement
- an unrestricted autonomous computer-use executor
- a mandatory runtime dependency for Kyberion core flows
- a place to embed opaque Apple-specific behavior inside ADF

If a flow depends on Apple-specific capability, it must remain observable and fall back cleanly.

## Routing Rules

Use Apple Intelligence when:

- the user is on supported Apple hardware
- the interaction is local and latency-sensitive
- privacy and offline behavior matter
- the task is naturally mediated by Mac UI, screenshot context, or app intents

Fall back to other providers when:

- the capability is unavailable on the current device
- the workflow needs cross-platform determinism
- the task requires broad external model coverage
- the task is better served by existing Kyberion voice or image providers

## Boundary With Computer Use

Apple Intelligence can assist the computer-use loop, but it should not replace the loop.

Kyberion should keep the separation:

- Apple Intelligence supplies observation or a suggested action
- Kyberion validates and routes the action
- the executor performs the actual step
- the receipt records what happened

That preserves the governed runtime loop already described in `computer-use-runtime-model.md`.

## Boundary With Voice

For voice, Apple Intelligence is useful as a low-friction local path, but Kyberion still needs a provider abstraction.

That means:

- voice pipeline selection stays policy-driven
- local Apple-backed behavior is one engine option
- cloud and other local engines remain available
- user consent and device capability checks stay explicit

## Proposed Integration Shape

1. Add an Apple Intelligence adapter in the native capability bridge.
2. Register the supported capabilities separately from the executor.
3. Route vision, voice, and intent-action to the smallest viable capability.
4. Record the execution receipt with capability, adapter, device, and fallback path.
5. Keep ADF contracts provider-neutral.

## Practical Priority Order

If Kyberion adopts this next, the order should be:

1. screenshot / image understanding
2. voice input and output
3. OS-backed intent actions
4. more advanced computer-use style assistance

That keeps the first slice useful without overcommitting to speculative automation.

## Implementation status (2026-07-09)

**v1 landed — text assist lane.**

- `tools/apple-intelligence-bridge/afm.swift` — dependency-free Swift CLI over
  FoundationModels (`availability` / `prompt`), compiled on demand with a
  single `swiftc` into `active/shared/runtime/apple-intelligence/afm`.
- `libs/core/apple-intelligence-bridge.ts` — governed Node entry
  (managed-process spawn, availability probe with 10-min cache,
  `KYBERION_APPLE_FM=0` opt-out). Helpers: `appleFmPrompt`,
  `classifyLocallyWithAppleFm`, `summarizeLocallyWithAppleFm`. Every helper
  returns `null` on any failure — callers keep their existing path.
- Deliberately NOT a ReasoningBackend: the ~3B on-device model serves the
  light assist lane (summaries, formatting, pre-classification, short UI
  text), never mission planning or structured extraction.
- Verified live on macOS 27 / Apple Silicon: availability probe, Japanese
  intent classification, and one-sentence summarization
  (`pnpm check:apple-fm`).

Lane status (2026-07-09):

- **Text assist** — landed (`prompt`, classify/summarize helpers).
- **Vision** — landed (`vision`: OCR + scene labels;
  `verifyRenderedTextWithAppleVision` render-QA primitive).
- **Speech (STT)** — landed (`transcribe` via SpeechAnalyzer/
  SpeechTranscriber, ja-JP installed on the dev machine; verified with a
  say→transcribe round trip). Wired into the repo-wide
  `SpeechToTextBridge` contract: reasoning-bootstrap registers
  `apple-speech` automatically when no `KYBERION_STT_COMMAND` is set, so
  in-room minutes recording and requirements-audio pipelines transcribe
  locally with zero configuration (E2E verified through
  `getSpeechToTextBridge().transcribe`). Voice OUTPUT stays with the
  existing voice-actuator engines (`local_say` etc.) — no duplication.
- **Image Playground** — landed with probe-and-degrade
  (`imagine-availability` / `imagine` → ImageCreator). It is now connected to
  the governed `generate_image` provider as `apple_playground`; the provider
  emits PNG artifacts and falls back to local FLUX/ComfyUI when the Image
  Playground model is not enabled. The low-level helper still returns null on
  unsupported devices so non-generation callers keep their existing path.
- **App Intents** — see the governed Shortcuts operations below.

## macOS 27 capability bridge integration (2026-10-29)

The bridge exposes `probeAppleIntelligenceCapabilities()` to report OS version,
local model availability, and version-gated lanes. `pnpm kyberion doctor` and
`pnpm check:apple-fm` display this matrix even when the text model is unavailable.
A matrix flag describes a lane prerequisite; it is not proof that an end-to-end
operation or its required assets are ready. Image Playground and PCC retain
separate live probes. Neither diagnostic automatically probes PCC: cloud access
requires an explicit opt-in. `KYBERION_APPLE_FM=0` disables bridge use.

The bridge includes image-prompt, dynamic-session, PCC and Core AI helpers.
Native compile and round-trip evidence is recorded separately in the mission;
mock-based tests alone do not establish device readiness. Core AI accepts a
normal-file `.aimodel` asset; package directories are outside the supported asset contract, and actual model inference
has not been verified. The live Evaluations compile probe found the framework
unavailable in this SDK. Evaluations remains a gated scaffold: detecting an
importable framework does not implement dataset evaluation.

The system actuator exposes
`apple_capabilities` for the local capability matrix and `ask_screen` for
screenshot-to-multimodal questions, reusing the existing screenshot observation
path. Their registration, schemas and controlled handler tests are part of the
integration; a real screen-capture round trip has not been run.

The `list_shortcuts` and `run_shortcut` operations require an active tenant.
Execution requires a human-only approval, expiring after 15 minutes, bound to the
exact shortcut name, input digest, tenant and timeout. The approval draft shows
the input so the human can inspect what they authorize. The approval is consumed
before launch; an audit receipt records the outcome, and confidential input
scratch files are cleaned up. Focused combined handler and bridge tests passed
94 cases using controlled runners. No real shortcut listing, shortcut execution
or screen capture was performed by those tests. The capability matrix does not
authorize cloud egress, screen capture or actions.

### Integration lessons and verification boundaries

An OS version check protects execution, while an SDK capability check protects
compilation. New framework imports and symbols need compile-time guards as well
as runtime availability checks so an optional lane does not disable older local
lanes. Verify both the native compile target and the emitted framework linkage;
a successful build against the current SDK with a macOS 26 deployment target
does not establish compatibility with a macOS 26 SDK that was not tested.

Keep capability discovery, operation readiness and authority separate. A live
framework probe may confirm installation while an operation still lacks model
assets or implementation. It must remain unavailable in that state. A cloud
probe does not grant permission to send data; a screen-question helper does not
grant screen-recording access; and finding a shortcut does not authorize its
execution. Session requests use one overall deadline rather than advertising an
unimplemented deadline for each request.

## Shared perception integration (2026-10-29)

The normal OCR provider can reuse the compiled native Vision bridge where it is
supported, retaining line confidence and normalized bounding boxes for redaction.
The legacy OCR path remains the fallback for unsupported hosts or toolchains.
This avoids repeatedly interpreting Swift for each image: the public Concierge
screenshot previously hit the legacy provider's 15-second startup deadline,
while the cached native bridge returned readable Japanese text.

Generative Apple image description remains an explicitly selected experimental
provider. It is not the default for detailed descriptions or dirty-tile screen
state: a real test incorrectly described a no-pending-decisions screen as a
processing error. OCR grounding alone did not consistently prevent invented UI
facts. Successful invocation and provider selection are not quality evidence.
The configured reasoning vision backend remains the default for those tasks.

Dirty-tile source-path tier and caller-declared tier are combined conservatively
before temporary files are created. Nonpublic work/state directories must retain
the source tier and tenant. Default perception entrypoints authorize the original
content before preparation or provider selection; a redacted public copy cannot
lower the source tier. Policy or redaction errors stop inference.

Speech registration uses a dedicated locale/asset readiness probe instead of
FoundationModels text availability. The probe never downloads assets. Explicit
STT commands retain precedence, and unavailable SpeechAnalyzer assets leave the
existing fallback in place. On this macOS 27.2 host, Japanese and English are
supported but their SpeechAnalyzer assets are not installed. Doctor and the
Apple check command display that state independently of the text model.

The text classification helper accepts only an exact supplied category label;
refusals and sentences containing a category do not become execution decisions.
Automatic surface reply rewriting remains a future integration: cold compilation
and probe latency need a total budget, and confirmation questions and approval
metadata must survive any presentation rewrite.

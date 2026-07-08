---
title: Apple Intelligence Native Capability Bridge
kind: architecture
scope: repository
authority: reference
phase: [alignment, execution]
tags: [apple-intelligence, macos, vision, voice, computer-use, governance]
owner: ecosystem_architect
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

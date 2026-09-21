---
title: Seam Provider Selection — Choosing Between Providers of the Same Function
kind: reference
scope: repository
authority: reference
phase: [alignment, execution]
tags: [seam, provider, selection, capability-broker, browser, lightpanda, governance, audit]
owner: ecosystem_architect
last_updated: 2026-09-22
---

# Seam Provider Selection

Some seams have several providers that do the same job with different
capabilities and characteristics — `browser-automation-runtime` has Chromium
(full fidelity, signed-in profiles) and Lightpanda (fast, light, no layout).
Choosing between them is **deterministic**, **audited** and **pinned per
mission**; it is not an LLM judgment.

Code: `libs/core/seam-provider-selection.ts` (pins via
`libs/core/capability-broker.ts`). Policy: one file per seam under
`knowledge/product/governance/seam-provider-selection/<seam>.json`.

## The three steps

1. **Hard filter (code truth).** The seam's caller marks every provider
   eligible or not from what the task actually needs. For the browser this is
   the same capability preflight that rejects unsupported ops
   (`preflightBrowserRuntimePipeline`), run against each registered runtime.
2. **Purpose ranking (policy).** The task states a purpose; eligible providers
   are scored as `Σ weight(purpose, trait) × trait(provider)`. Ties go to the
   seam default, then provider id. Unknown purposes fail closed.
3. **Record and pin.** Every decision goes to the audit chain
   (`action: provider_selection`, operation `<seam>/<provider>`, with
   eligible / excluded / scores / rationale). Inside a mission
   (`MISSION_ID` set) a fresh decision is pinned under
   `seam_pins["<seam>:<decisionKey>"]` of the mission's provider pins, and
   later runs reuse it. A pin the current task cannot use is **not**
   overwritten — that run falls back and says so in the rationale.

No purpose = the seam default. An explicit provider always wins; selection
never moves a task off the default unless the task asked for a purpose.

## Traits must say where their numbers come from

Every trait value carries `trait_basis: measured | declared` plus `evidence`
links, and the rationale prints the basis (`speed=0.6×1 (declared)`).
Declared values are claims (e.g. upstream benchmarks); promote them to
`measured` only with a local measurement, the same honesty rule as
`backend-capability-honesty.ts` for reasoning backends.

## Browser runtime usage

| Caller                        | How                                                                       |
| ----------------------------- | ------------------------------------------------------------------------- |
| Pipeline / ADF                | `options.runtime_purpose: "throughput"` (no `browser_runtime`, or `auto`) |
| `pnpm kyberion browser run`   | `--browser-purpose throughput` (host flag wins over pipeline options)     |
| `pnpm kyberion procedure run` | `--browser-purpose throughput`                                            |

Purposes today: `evidence` (fidelity), `throughput` (speed + footprint),
`authenticated` (signed-in sessions). Verified 2026-09-22: a read-only
pipeline with `throughput` runs on Lightpanda; the same purpose with a
`screenshot` step falls back to Chromium (Lightpanda excluded, mission pin
kept); `evidence` picks Chromium; a re-run reuses the mission pin.

## Seams wired in

| Seam (policy file)           | Caller option                                                                                                                          | Purposes                            | Eligibility (hard filter)                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `browser-automation-runtime` | pipeline `options.runtime_purpose`; CLI `--browser-purpose`                                                                            | evidence, throughput, authenticated | pipeline ops/options vs runtime capabilities                                                      |
| `image-generation-provider`  | `ImageGenerationRequest.purpose`; media-generation `generate_image` `purpose`                                                          | quality, speed, privacy, cost       | `mode` (local_only / privacy_first), `isAvailable()`, host bridges only with `allow_host_handoff` |
| `ocr-provider`               | `OcrRequest.purpose`; vision-actuator `ocr_image` `purpose`                                                                            | accuracy, speed, privacy, cost      | `mode` egress filter, `isAvailable()`                                                             |
| `speech-to-text-bridge`      | `selectSpeechToTextBridges({ purpose, requires })`; voice-actuator `transcribe` / `transcribe_voice_sample` `purpose` (backend `auto`) | accuracy, latency, privacy          | declared timestamps granularity, `local_only`, synthetic (stub) only when allowed                 |

In every seam an explicit provider (`browser_runtime`, `providerPreference`,
voice `backend`) wins and skips selection, and no purpose keeps the existing
routing. Image and OCR walk `decision.ranked` as their fallback chain.

Deliberately not wired (2026-09-22): TTS / voice engines (the engine decides
_whose_ voice speaks and is bound to voice profiles and the clone-tier
routing policy; engines declare no languages yet), video generation (API
models are only used when named explicitly), music (two providers with the
same declared traits), VAD, streaming STT/TTS (no capability metadata), and
device- or account-bound seams (camera, audio bus, calendar, meeting drivers).
voice-hub keeps its own STT order (`libs/core/voice-stt.ts`).

## Adding another seam

1. Give its providers capability declarations the caller can check.
2. Add `knowledge/product/governance/seam-provider-selection/<seam>.json`
   (`seam_id`, `default_provider`, `traits`, `providers` with traits + basis +
   evidence, `purposes`).
3. In the caller, build `{ id, eligible, unmet }` candidates and call
   `resolveSeamProviderDecision({ seam, candidates, purpose, decisionKey })`.
   Write the chosen id back where downstream code reads it so nested calls do
   not re-select. Seams that run a fallback chain walk `decision.ranked`
   (eligible providers, best first) instead of using only `provider_id`.

---
title: Media & Voice Extension Mechanism
category: Architecture
tags: [media, voice, seam, provider-registry, extension-points]
importance: 7
last_updated: 2026-11-03
---

# Media & Voice Extension Mechanism

Canonical record of which registry/selection mechanism is authoritative for
each media and voice extension point. Prior to 2026-11 the same domain had
parallel mechanisms (JSON backend catalog, ad-hoc actuator-local seams,
static adapter tables), which made "where do I register a new provider?"
ambiguous. This document fixes the layering.

## Layer model

```
media-backend-registry.ts      deployment catalog: which backends exist,
                               availability probe, capability records.
                               Answers "what is installed / reachable?".
<modality>/provider-registry   seam-backed extension registry.
                               Answers "what may be selected?".
<modality>/router (or bridge)  ProviderChainRouter / seam-provider-selection.
                               Answers "which one runs for this request?".
governance/admission           runExternalOperation wrappers around the
                               selected provider's external effects.
```

A new provider normally registers at the **seam layer**, advertises itself
through the backend catalog only when it is a deployable backend with a
distinct availability probe, and is picked by the router through governed
policy (`knowledge/product/governance/seam-provider-selection/*.json`).

## Canonical extension point per modality

| Modality         | Extension seam                                           | Registration                                                    | Selection                                      |
| ---------------- | -------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| OCR              | `ocr-provider`                                           | `libs/core/ocr/provider-registry.ts` (`createProviderRegistry`) | `ocr/router.ts` (`ProviderChainRouter`)        |
| Image generation | `image-generation-provider`                              | `libs/core/media/image-generation/provider-registry.ts`         | `image-generation/router.ts`                   |
| Music generation | `music-generation-provider`                              | `libs/core/media/music-generation/provider-registry.ts`         | `music-generation/router.ts`                   |
| Video generation | `video-generation-provider-adapter`                      | `libs/core/media/video-generation/provider-registry.ts`         | `video-generation/provider.ts` selection block |
| Voice engines    | `voice-engine`                                           | `libs/core/voice/voice-engine-registry.ts` (`defineCatalog`)    | `engine-runtime-preferences`                   |
| TTS / STT / VAD  | per-kind seams (`streaming-tts`, `streaming-stt`, `vad`) | `libs/core/voice/*-bridge.ts`, `vad-registry.ts`                | seam-provider-selection rules                  |
| Viseme           | `viseme-provider`                                        | `libs/core/voice/viseme-provider-registry.ts`                   | seam-provider-selection                        |

## Rules for new work

- Prefer `createProviderRegistry<T>` (`libs/core/provider-registry.ts`) for
  any new "register named providers" extension point — it owns seam
  declaration, lifecycle reset, and revision tracking in one place.
- Prefer `ProviderChainRouter` (`libs/core/provider-chain-router.ts`) when
  selection = eligibility filter → governed policy → default chain →
  fallback execution. Domain constraints go in hooks, not in a forked
  router.
- Provider ordering lives in governed policy `default_chains`
  (`knowledge/product/governance/seam-provider-selection/<seam>.json`);
  in-router literals are allowed only as hermetic test fallbacks.
- `media-backend-registry` records describe deployments, not plugin
  providers; do not add provider selection logic there.
- `voice-provider-adapters.ts` static tables are the contract shape for
  engine adapters (metadata + factory); engine-level registration still
  goes through the voice-engine catalog.

## Status of convergence (2026-11-03)

- Done: OCR/image/music registries + routers converge on the shared
  primitives; provider default order is policy data.
- Done: video generation moved from `libs/actuators/` into
  `libs/core/media/video-generation/` with sibling layout
  (`types.ts`, `provider-registry.ts`, `providers/`, `builtin-adapters.ts`,
  `admission.ts`, `provider.ts`); the actuator keeps a re-export shim.
- Deferred: unifying `defineCatalog` (voice engine registry) and
  `createProviderRegistry` into a single primitive — both now sit on
  `seam.ts`, but keep distinct APIs because catalog entries carry
  capability records rather than adapter instances.

## God-file decomposition map (2026-11-03)

- Done: `libs/core/metrics.ts` → `libs/core/metrics-cost-registry.ts`
  (model-cost registry: types, catalog load/cache, rate resolution).
  `metrics.ts` re-exports the public surface, so existing imports are
  unchanged.
- `libs/core/storage-janitor.ts`: the event-store / append-only sweep
  section (`scanEventStores`, `scanStorageFloors`, `sweepStatusRules`,
  `sweepSupervisorEventFiles`, `sweepAppendOnlyStores`, ~600 lines) is the
  next extraction target as `storage-janitor-event-stores.ts`; it needs the
  shared helpers (`collectFiles`, `expireFilePerPolicy`, `analyzeStoreKeys`,
  retention-catalog accessors) hoisted into `storage-janitor-support.ts`
  first.
- `libs/core/tier-guard.ts`: split candidates are the pure path-policy
  matchers (`expandPolicyPath`, `policyPathMatches`, `denyCandidatePaths`,
  `denyPatternMatches`, `readGrantMatches`) into
  `tier-guard-path-policy.ts`, then tenant-scope checks into
  `tier-guard-tenant-scope.ts`.
- `libs/core/secure-io.ts`, `libs/core/dot/dot-runtime.ts`,
  `libs/core/reasoning/reasoning-backend.ts`: keep whole for now; they need
  behavior-preserving extractions behind their existing test suites and
  should be done one file per change.

## Mobile runtime helpers

Shared iOS/Android pipeline primitives
(`ensureParentDir`, `safeOrigin`, `resolveObjectRef`, `resolveAppProfile`,
`buildSessionHandoffArtifact`) live in
`libs/core/mobile-runtime-helpers.ts`. The platform-specific `opApply` /
`opCapture` / `opTransform` implementations stay in each actuator — their
selector strategies and device pipelines genuinely differ.

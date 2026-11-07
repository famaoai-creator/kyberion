---
title: Workspace Package Layering
category: Architecture
tags:
  [architecture, packages, layering, dependency-direction, shared, interaction, voice, perception]
importance: 8
author: Ecosystem Architect
last_updated: 2026-11-07
kind: architecture
scope: repository
authority: reference
phase: [alignment, execution, review]
role_affinity: [ecosystem_architect, solution_architect, implementer, reviewer]
---

# Workspace Package Layering

`@agent/core` is the control plane and the shared primitives every runtime needs.
Capability runtimes that core itself does not call live in `libs/shared-*`
packages, which depend on core. The direction is one-way and enforced.

```
libs/actuators/*, scripts/, presence/, satellites/
        │
        ▼
libs/shared-*  (video, media, voice, vision, interaction, network, ui, ...)
        │
        ▼
@agent/core  ──▶  @agent/kernel
```

## Package responsibilities and classification

A package is a build and dependency boundary. A directory inside core is an ownership
and module-layer boundary, not a separate workspace package. In particular,
`libs/core/foundation` and `libs/core/contracts` belong to `@agent/core`; there is no
`libs/foundation` workspace package. Do not create one merely to reduce the core file count.

| Boundary                               | Owns                                                                                                              | Does not own                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `@agent/kernel`                        | Storage backend contracts and append-only entry-ledger mechanics without a core dependency                        | Tenant policy, identity, approval or application workflow                                  |
| `@agent/core`                          | Governed control plane: authority, secure I/O, scope, lifecycle, registries and bridges reused by core subsystems | Capability-specific runtimes that core does not call                                       |
| `core/foundation`                      | Low-level primitives and the minimal enforcement machinery required by governed I/O                               | Business rules, provider orchestration or capability workflows                             |
| `core/contracts`                       | Shared types, identifiers, vocabulary and wire contracts                                                          | Registry loading, execution or mutable domain state                                        |
| Core domain directories                | A named subsystem's policies, state and services, such as mission, organization, voice or provider                | Unrelated utilities grouped only by having few imports                                     |
| Core orchestration layer               | Coordination across subsystem services and execution lifecycles                                                   | New low-level primitives or another copy of subsystem state                                |
| `libs/shared-*`                        | Reusable capability runtimes consumed by actuators, scripts and surfaces                                          | Implementations still needed by core; shared does not mean a miscellaneous utility package |
| `libs/actuators/*`                     | Validated operation entry points, operation-specific authorization and runtime adaptation                         | A second implementation of reusable domain logic                                           |
| `scripts/`, `presence/`, `satellites/` | CLI, HTTP/UI and runtime composition entry points                                                                 | Canonical domain rules duplicated per entry point                                          |

The module layers describe allowed dependencies, not necessarily directories:
an orchestration file may live beside its domain files, but remains classified by
`module-layer-boundaries.json`. Foundation is not entirely I/O-free: `secure-io`
and its explicitly reviewed bootstrap dependencies already form the enforcement boundary.
Pure helpers must not acquire those dependencies just because both are low-level.

### Placement procedure

1. Identify the responsibility from behavior and state ownership, then inspect runtime
   and type importers across the repository. A filename or zero imports is insufficient.
2. Separate generic primitives, shared contract vocabulary, domain policy and orchestration.
   Keep a dependency-free business rule in its domain.
3. If core still calls the implementation, place it under the appropriate core subsystem.
   Extract a capability runtime into `shared-*` only after its incoming core dependency
   closure is removed; never introduce a core-to-shared import to make a move compile.
4. Check sibling consumers before moving a shared registry into one capability package.
   Cross-capability ownership remains in core unless a separate lower boundary is justified.
5. Move one coherent slice with its tests, update all importers and facade exports, and
   decide public subpath compatibility explicitly. Do not leave single-module reexport shims.
6. Verify affected tests and the core/package builds. Use `module-boundaries`,
   `package-export-surface`, `foundation-weight` and `package-dependency-graph` for the
   boundaries they actually enforce; none proves semantic ownership by itself.

### First classification slice (2026-11-07)

| Module                | Classification and destination                     | Reason                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bounded-audio-queue` | Voice domain, `core/voice/` (moved with its tests) | Depends on audio-route and meeting audio contracts; core audio buses and the shell TTS bridge use it. Keep the existing root export; no new public subpath.                                                   |
| `business-calendar`   | Temporal domain, `core/temporal/`                  | Japanese holiday and bank-day rules serve organization, meeting and temporal-context. The existing `@agent/core/business-calendar` subpath remains stable while its export target follows the implementation. |

### Continued classification (2026-11-07)

| Modules                                                                                                                                                         | Destination         | Responsibility and compatibility                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider-chain-router`, `provider-registry`, `provider-runtime-requirements`                                                                                   | `core/provider/`    | Provider registration, routing and runtime prerequisites used by core; retain existing public subpath keys.                                                                                              |
| `llm-selection-preferences`, `llm-selection-state`, `backend-capability-profile`, `backend-capability-honesty`, `backend-conformance`, `backend-live-scenarios` | `core/reasoning/`   | Reasoning selection state, declared capabilities and observed conformance; retain existing public subpath keys and measurement protections.                                                              |
| `barge-in-controller`, `blackhole-routing-guard`, `pulse-audio-bus`, `blackhole-audio-bus`, `coreaudio-device-inventory`, `coreaudio-output-bridge`             | `core/voice/`       | Device and audio-route primitives used by core meeting/audio services; retain existing public subpath keys. Native Swift helper paths remain unchanged.                                                  |
| `business-calendar`, `temporal-context`                                                                                                                         | `core/temporal/`    | Business-day, timezone and working-hours interpretation shared by meeting and organization; domain policy rather than foundation. Preserve the calendar subpath and temporal-context root export.        |
| `segmented-voice-playback`, `streaming-voice-playback`                                                                                                          | `shared-voice/src/` | Speech synthesis/playback orchestration with no incoming core implementation dependency. Move the closure and its tests, remove core reexports/subpaths, and migrate consumers to `@agent/shared-voice`. |

The playback extraction deliberately changes those two package import paths; core must
not reexport shared-voice to preserve an old import. Internal core relocations preserve
their existing package APIs by changing export targets instead of adding shim files.
Moved boundary allowlist entries keep their existing budgets and permissions.

These slices establish the placement procedure. They do not classify all remaining
flat core modules or turn the internal foundation directory into a package. Seam selection,
platform bootstrap, authority and secure-I/O foundations need separate dependency reviews.

## Enforced dependency rules

- `@agent/core` never imports `@agent/shared-*` (lint: `no-restricted-imports` on `libs/core/**`).
- A module moves out of core only when no core module (outside its own directory) imports it.
  Compute that closure before moving; what core still uses stays in core.
- The published surface may only shrink unless a change raises the baseline in review
  (gate `package-export-surface`, baseline `scripts/check_package_export_surface.baseline.json`).
- Foundation stays light: the gate `foundation-weight` (baseline
  `scripts/check_foundation_weight.baseline.json`) counts, on `libs/core/dist`, how many core
  modules `secure-io`, `path-resolver`, `logger` and every `foundation/**` / `contracts/**`
  module load at runtime. The 2026-11-07 measurement is 53 modules for `secure-io`;
  most are the guard's own machinery (audit chain,
  policy engine, identity, tenant partitions, vault, sandbox); a new domain rule must not add to it.
- Reviewed security repair exception (2026-11-06, `MSN-CREDENTIAL-LIFETIME-20261106`):
  the existing credential-material role now checks its private live issuer on every I/O,
  closing a reproduced stale queued-callback permission gap. Its pure proof module adds
  exactly one transitive module to secure-io and five dependent watched foundations;
  only those six measured budgets increase by one. It performs no catalog, identity or
  network I/O. Authority's identity bridge did not already load this module. Preserve
  the direct proof rather than introducing replaceable admission callbacks or moving
  credential policy into generic resource machinery to avoid the count. This exception
  restores the existing synchronous lifetime contract; it does not permit future
  domain rules to grow foundation without a separate measured review.
- The package graph is generated, never hand-drawn
  (gate `package-dependency-graph` → `docs/developer/architecture/dependency-graph.mmd`).

## Inside core: foundation and contracts first

Core itself is layered `foundation → contracts → domain → orchestration`
(`knowledge/product/governance/module-layer-boundaries.json`, gate `module-boundaries`).

- `libs/core/foundation/` holds low-level utilities (text escaping, HTML sanitising,
  locale vocabulary, message formatting, PCM/WAV, origin matching, ...). A foundation module
  imports nothing above foundation.
- `libs/core/contracts/` holds shared vocabularies, ids and contract types (OCR types, NHI ids,
  rejection reasons, risky-op ids, execution shape/bounds, wire errors, evidence, judge
  route, ...). It may import foundation only; `contracts/**` is declared as the contracts layer.
- A flat `libs/core/<name>.ts` that imports no other core module is a candidate for one of the
  two. Move it only when its content is generic (utility) or a shared vocabulary (contract);
  a dependency-free module with domain meaning (mission lookup, working principles, ...) stays
  with its domain. The public subpath follows the file (`@agent/core/foundation/<name>`,
  `@agent/core/contracts/<name>`).

- A flat module that implements one core subsystem moves into that subsystem's directory
  (`authn-providers` → `authn/`; `cli-provider-bundle`, `provider-transport`,
  `completion-token-budget` → `provider/`).
- A flat file that only re-exports one module is deleted and its importers point at the module;
  a deliberate multi-module facade with many consumers (`@agent/core/governance`) stays.
- A registry shared by several `shared-*` packages and actuators (for example
  `voice/voice-profile-registry`) stays in core: moving it into one shared package would make
  its sibling packages depend on each other.

## Placement guide

| Package              | Holds                                                                                               | Stays in core instead                                                |
| -------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `shared-video`       | ingest, composition compile/render, filters, recut                                                  | video contracts, design system, frame bus/route/lease/archive        |
| `shared-media`       | document generation engines, image/music/video generation, layout and drawio policies               | document reader, docx/xlsx/pptx utils, pdf parser, image description |
| `shared-voice`       | realtime voice conversation loops, voice generation runtime, samples, selection, turn-taking        | audio bus/route, STT/TTS bridges, VAD, voice-engine registries       |
| `shared-vision`      | browser automation bridge, extension mailbox, browser conversation, onboarding, procedure promotion | extension bridge, recording compiler, Chrome meeting driver          |
| `shared-perception`  | observation scoping, audio analysis, visual change, tracking, semantic index (+ Python helpers)     | STT/VAD/OCR/image-description bridges it calls                       |
| `shared-interaction` | modality-independent conversation control                                                           | —                                                                    |
| `shared-network`     | MCP client/server runtime, HTTP transport and protocol-facing tool adaptation                       | authority, governed network I/O and core service registries          |
| `shared-ui`          | React and vanilla renderers for the shared A2UI/component catalog                                   | viewer authorization and domain decisions                            |
| `shared-mobile`      | device-independent frame sources, input injection and live-mirror runtime                           | platform facts and governed OS actions                               |
| `shared-nerve`       | reflex-engine runtime composition                                                                   | core sensing bridges, authority and lifecycle ownership              |

## Listen, think, speak: layer by role, not by sense

A conversation is a control loop (Observe → Infer state → Decide who acts → Act),
not `STT → LLM → TTS` in series. Split it by role:

| Human behaviour        | Role                                                                                            | Package                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| hear / see / read      | sensing bridges (STT, VAD, image description, document reader)                                  | core (shared by meeting, shell, perception)               |
| decide _when_ to speak | turn-taking, backchannels, user rhythm, utterance intent, reply structure                       | `shared-interaction` (no I/O; clock is the input `at_ms`) |
| decide _what_ to say   | reasoning backend                                                                               | core                                                      |
| speak / draw           | TTS and playback bridges in core; voice runtime in `shared-voice`; generation in `shared-media` | core + shared                                             |

Do not split listening and speaking into separate packages: realtime conversation listens
while speaking (barge-in, echo/loopback checks), so such packages would depend on each other.
Split by layer instead — device bridges (core) → modality runtime (`shared-voice`) →
interaction control (`shared-interaction`). A text chat or meeting facilitator reuses
`shared-interaction` without the voice runtime.

`shared-perception` turns the core sensing bridges into scoped observations for
`kyberion read / see / listen / watch`; the bridges themselves stay in core because meeting,
shell and the voice runtime share them.

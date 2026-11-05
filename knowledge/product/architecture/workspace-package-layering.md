---
title: Workspace Package Layering
category: Architecture
tags:
  [architecture, packages, layering, dependency-direction, shared, interaction, voice, perception]
importance: 8
author: Ecosystem Architect
last_updated: 2026-11-05
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

## Rules

- `@agent/core` never imports `@agent/shared-*` (lint: `no-restricted-imports` on `libs/core/**`).
- A module moves out of core only when no core module (outside its own directory) imports it.
  Compute that closure before moving; what core still uses stays in core.
- The published surface may only shrink unless a change raises the baseline in review
  (gate `package-export-surface`, baseline `scripts/check_package_export_surface.baseline.json`).
- The package graph is generated, never hand-drawn
  (gate `package-dependency-graph` → `docs/developer/architecture/dependency-graph.mmd`).

## Inside core: foundation and contracts first

Core itself is layered `foundation → contracts → domain → orchestration`
(`knowledge/product/governance/module-layer-boundaries.json`, gate `module-boundaries`).

- `libs/core/foundation/` holds dependency-free utilities (text escaping, HTML sanitising,
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

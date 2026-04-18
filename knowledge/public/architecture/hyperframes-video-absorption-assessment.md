---
title: HyperFrames Video Absorption Assessment
category: Architecture
tags: [video, rendering, html, capture, governance, assessment]
importance: 9
author: Ecosystem Architect
last_updated: 2026-04-19
---

# HyperFrames Video Absorption Assessment

## Executive Verdict

Yes, Kyberion can absorb important parts of HyperFrames.

The parts worth absorbing are not the product shell itself.
The value is in:

- deterministic HTML-to-video rendering
- website-to-video capture and planning workflow
- block and composition registry patterns
- render queueing, progress streaming, and readiness gates

Kyberion should not absorb HyperFrames as a new top-level product mode or as a direct foreign runtime.
It should absorb the reusable execution patterns and re-express them through governed contracts, isolated execution, and existing actuator boundaries.

## What HyperFrames Actually Is

Based on the inspected repository, HyperFrames is structured around these layers:

- `core`
  - HTML composition model
  - runtime and timeline control
  - linting and bundling
- `engine`
  - deterministic frame seeking and capture
  - Chrome/BeginFrame orchestration
  - parallel frame capture helpers
- `producer`
  - render job orchestration
  - FFmpeg encoding
  - audio mixing
  - queueing and SSE progress
- `registry`
  - reusable blocks, components, and examples
- `cli` and `skills`
  - agent-facing workflow for capture, storyboard, VO, validation, and render

This is materially different from Kyberion's current video path, which is primarily a prompt-driven `video-generation-adf -> ComfyUI workflow` route.

## Kyberion Gap Analysis

Kyberion already has:

- a governed `video-generation-adf`
- `media-generation-actuator` for image, music, and prompt-based video generation
- browser automation and browser video evidence capture
- orchestration patterns for generation jobs

Kyberion does not yet have a strong foundation for:

- deterministic HTML composition rendering as a first-class video path
- governed website-to-video capture artifacts
- reusable video scene/block catalogs
- render queue policy with explicit queue visibility
- structured readiness gates for frame-safe rendering
- a split between `generative video` and `composed deterministic video`

That is the main absorption opportunity.

## Parts To Absorb

### 1. Deterministic Composition Rendering

This is the highest-value pattern.

HyperFrames treats video as:

`composition -> seek each frame -> capture -> encode -> mix audio -> artifact`

Kyberion should absorb this as a second governed video path next to model-generated video.

Recommended Kyberion shape:

`intent -> video-composition-adf -> governed compiler -> isolated render job -> artifact lineage`

Why this fits:

- it matches Kyberion's contract-first model
- it is better for explainers, demos, narrated product tours, overlays, and data videos
- it complements, rather than replaces, ComfyUI-style generated clips

### 2. Readiness Gates And Determinism Rules

HyperFrames explicitly waits for composition readiness before capture and enforces a seek-driven render contract.

Kyberion should absorb:

- explicit `player_ready` / `render_ready` style gates
- no wall-clock rendering rule
- no render-time network fetch rule
- fixed output parameter lock before render start
- finite-duration enforcement

These should become Kyberion governance rules, not just implementation details.

### 3. Render Queue And Progress Streaming

HyperFrames' producer layer has a simple but effective semaphore, queue endpoint, and SSE progress stream.

Kyberion should absorb:

- max concurrent render policy
- queue position reporting
- streamed progress packets for long renders
- render cancellation states
- output artifact lease and download indirection

This aligns well with Kyberion's existing job-oriented execution model and would materially improve operator visibility.

### 4. Website-To-Video Workflow Artifacts

The `website-to-hyperframes` skill is opinionated, but the underlying workflow is strong.

The reusable part is not the slash-command UX.
The reusable part is the artifact sequence:

- site capture
- design summary
- script
- storyboard
- TTS and transcript timing
- composition build
- validation

Kyberion should absorb this as a governed pipeline for:

- marketing explainers
- product walkthroughs
- landing-page-based promo videos
- narrated business case videos

This maps naturally to Kyberion's intent -> plan -> execution -> evidence model.

### 5. Registry Pattern For Reusable Video Blocks

HyperFrames has a practical registry model for examples, blocks, and components.

Kyberion should absorb the concept, not the exact file format:

- reusable scene blocks
- transition packs
- overlay components
- video composition templates
- governed install/selection metadata

This is especially valuable because Kyberion already uses knowledge-owned templates and catalogs in adjacent domains.

### 6. Transparent Overlay Output

HyperFrames treats transparent overlays as a real output mode, not an afterthought.

Kyberion should absorb:

- `mov` / `webm` overlay output handling
- transparency-aware render policy
- overlay-oriented template patterns

This would make lower thirds, caption overlays, agent avatar callouts, and UI highlight layers materially easier to produce.

## Parts Not To Absorb Directly

### 1. Arbitrary HTML Plus Arbitrary Script As A Public Contract

This is the biggest boundary mismatch.

HyperFrames can let an agent author raw HTML, CSS, and GSAP directly because that is its product shape.
Kyberion should not expose raw executable composition HTML as the primary public contract.

Kyberion should instead use:

- semantic briefs
- typed `video-composition-adf`
- governed compilers
- lint and preflight
- isolated render sandboxes

Raw HTML should remain an internal compiled artifact, not the default user-facing contract.

### 2. The Studio Product Shape

Kyberion should not absorb:

- standalone studio UX
- timeline-editor product identity
- HyperFrames-specific project scaffolding

Those are product decisions for HyperFrames, not reusable Kyberion architecture.

### 3. Agent-Specific Slash Skill Assumptions

HyperFrames is strongly optimized for direct agent prompting with local skills.

Kyberion should absorb the workflow logic, but keep:

- Kyberion governance ownership
- execution receipts
- approval boundaries
- mission and artifact lineage

### 4. Direct `node:fs` Style Internal Assumptions

HyperFrames internals are not written to Kyberion's `secure-io` rule set.
Any absorbed implementation needs a Kyberion-native port, not a blind import.

## Recommended Kyberion Target Shape

Kyberion should split video into two distinct governed families:

### A. Generative Video

Current direction:

`video-generation-adf -> media-generation-actuator -> ComfyUI or other model backend`

Best for:

- synthetic clips
- prompt-led motion generation
- backend workflow-driven video creation

### B. Composed Video

New direction:

`video-composition-adf -> deterministic html/canvas/svg renderer -> encoded artifact`

Best for:

- explainers
- product demos
- website-based promo videos
- captioned narrated videos
- overlays and lower thirds
- data-driven motion graphics

This distinction will keep Kyberion's concept map cleaner than overloading one video contract for two incompatible execution models.

## Recommended New Contracts

Kyberion should add a new governed family rather than stretching the current Comfy-oriented ADF:

- `video-composition-adf.schema.json`
- `video-render-progress-packet.schema.json`
- `video-composition-template-registry.json`
- `video-render-runtime-policy.json`
- `website-capture-bundle.schema.json`
- `video-storyboard.schema.json`

Suggested `video-composition-adf` responsibilities:

- scene list or composition references
- viewport and output format
- audio tracks and sync points
- timing and transition declarations
- template and block references
- deterministic adapter/runtime selection

## Recommended Runtime Architecture

Kyberion should not import HyperFrames wholesale.
It should port the architecture into Kyberion-native layers:

### Compiler Layer

- compile semantic video briefs into internal composition artifacts
- hydrate governed blocks and transitions
- bind narration, captions, and asset references

### Render Engine Layer

- isolated browser render runtime
- deterministic seek-and-capture loop
- fixed output settings
- readiness-gated capture start

### Producer Layer

- frame encoding
- audio mux
- transparent overlay output
- concurrency control
- progress packets
- cancellation

### Catalog Layer

- reusable blocks
- reusable transitions
- reusable composition templates
- capability metadata and policy status

## Where It Fits In The Current Repo

Recommended landing points:

- `libs/core/`
  - composition contracts
  - render runtime policy
  - progress packet types
  - template and registry loaders
- `libs/actuators/media-generation-actuator/`
  - keep model-led generation here
  - optionally add a separate deterministic video render path only if the actuator remains conceptually coherent
- `libs/actuators/browser-actuator/`
  - reuse for website capture and source evidence
- `knowledge/public/governance/`
  - render policy
  - template registry
  - transition and block registry
- `knowledge/public/procedures/media/`
  - website-to-video
  - narrated-video-from-brief
  - overlay-video-from-contract

If this grows materially, a dedicated `video-render-actuator` would be cleaner than overloading `media-generation-actuator`.

## Security And Maintainability Guardrails

Any absorption should preserve Kyberion's operating rules:

- all filesystem access through `@agent/core/secure-io`
- no ungoverned arbitrary HTML execution outside isolated render sandboxes
- preflight validation before render start
- render-time network fetch disabled by default
- asset staging into governed temp paths only
- explicit worker and concurrency limits in policy
- clear separation between reusable templates and ad hoc compiled artifacts

The critical rule is:

Kyberion should absorb HyperFrames' deterministic rendering model without absorbing its permissive execution boundary.

## Phased Absorption Plan

### Phase 1. Contract And Policy Foundation

- define `video-composition-adf`
- define progress packet schema
- define render runtime policy
- define template and block registry shape

### Phase 2. Website Capture And Planning Flow

- add governed website capture bundle
- add storyboard and script artifacts
- connect browser capture evidence into video planning
- connect voice generation foundation into narration generation

### Phase 3. Deterministic Render Runtime

- add isolated HTML composition render runtime
- implement readiness gates
- implement progress packets and cancellation
- implement queue visibility

### Phase 4. Reusable Catalog

- add template and transition registry
- add overlay and lower-third packs
- add product-demo and narrated-explainer starter templates

### Phase 5. Surface Integration

- expose as orchestrator-ready procedures
- expose operator-visible progress and queue state
- emit artifact lineage and reusable evidence

## Immediate Conclusion

The strongest reusable parts of HyperFrames are:

- deterministic browser-based video rendering
- governed capture-to-storyboard workflow
- reusable video template and transition registry patterns
- render queue and streaming progress behavior

Kyberion should absorb those patterns.
It should not absorb raw executable HTML authoring as a public interface, and it should not turn itself into a video studio product.

The right move is:

add a governed deterministic video-composition path beside the existing model-driven video-generation path.

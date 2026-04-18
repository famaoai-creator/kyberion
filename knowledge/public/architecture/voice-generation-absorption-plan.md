---
title: Voice Generation Absorption Plan
category: Architecture
tags: [voice, generation, governance, runtime, planning]
importance: 9
author: Ecosystem Architect
last_updated: 2026-04-18
---

# Voice Generation Absorption Plan

## Goal

Absorb the strongest reusable ideas from Voicebox into Kyberion without importing the desktop-studio product shape.

Kyberion should not become a voice editing app.
Kyberion should become better at governed voice generation, progress reporting, profile routing, and narrated artifact delivery.

## What To Absorb

From Voicebox, the most reusable technical patterns are:

- engine-agnostic backend contracts
- serial job execution for GPU-sensitive workloads
- long-text chunking with sentence-aware boundaries and crossfade
- progress streaming for long-running model and generation work
- artifact lineage for original, processed, and regenerated outputs

## What Not To Absorb

Kyberion should not absorb these as first-class product concepts:

- Tauri desktop application structure
- studio-centric React UI
- localhost-trust API assumptions
- voice timeline editor as a standalone product mode

Those are product-shape decisions, not core Kyberion operating-model improvements.

## Target Kyberion Shape

The absorbed capability should fit this path:

`intent -> voice-generation-adf -> governed runtime -> artifact/evidence -> operator packet`

This keeps the capability aligned with Kyberion's contract-first model.

## Implementation Tracks

### 1. Contract Track

Define canonical contracts for:

- voice generation request
- voice progress packet
- voice profile registry
- voice runtime policy

### 2. Governance Track

Add knowledge-owned governance for:

- available voice profiles and storage tier
- runtime queue and chunking policy
- approval and delivery defaults

### 3. Runtime Track

Add reusable runtime helpers for:

- sentence-aware text chunking
- serial voice job execution
- progress state snapshots and subscriptions
- cancellation and lifecycle transitions

### 4. Delivery Track

Use the runtime outputs to eventually power:

- voiced operator summaries
- narrated presence timelines
- artifact narration bundles
- transcription-backed voice ingress

This track is intentionally deferred until the foundations are stable.

## Concrete Deliverables

Phase 1 in this implementation adds:

- `voice-generation-adf.schema.json`
- `voice-progress-packet.schema.json`
- `voice-profile-registry.schema.json`
- `voice-runtime-policy.schema.json`
- `voice-profile-registry.json`
- `voice-runtime-policy.json`
- `voice-text-chunking.ts`
- `voice-generation-runtime.ts`

## Acceptance Criteria

The foundation is acceptable when:

- voice generation can be represented through a canonical contract
- long text can be chunked deterministically without splitting paralinguistic tags
- queued voice jobs execute serially with cancellation and observable progress
- voice profile and runtime policy governance validate through `check:governance-rules`
- tests cover both contract and runtime behavior

## Next Phase

After this foundation, the next implementation should wire the runtime into:

- `voice-actuator`
- `presence` narrated delivery
- `voice-hub` transcription and synthesis routing

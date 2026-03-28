---
title: Surface Responsibility Model
category: Architecture
tags: [architecture, surface, presence, chronos, ceo, responsibilities]
importance: 9
author: Ecosystem Architect
last_updated: 2026-03-29
---

# Surface Responsibility Model

## 1. Purpose

Kyberion should expose different surfaces for different human roles without duplicating authority or confusing responsibilities.

This document defines the expected role of the main human-facing surfaces:

- `Presence Studio`
- `Chronos`
- `CEO UX`

## 2. Core Rule

Each surface should optimize for one primary question.

- `Presence Studio`
  - what is Kyberion helping me with right now
- `Chronos`
  - what is the system doing and where should I intervene
- `CEO UX`
  - what matters, what needs approval, and what came out

If a surface starts trying to answer all three equally, the UX becomes noisy and conceptually weak.

## 3. Surface Roles

### 3.1 Presence Studio

Presence Studio is the conversational concierge surface.

Its job is to:

- receive live human intent
- smooth slot filling and follow-up dialogue
- show short plans
- expose active work detail
- expose browser help and current task results
- return artifacts and immediate next steps

Presence Studio should feel like the front desk of the operating system.

It should not become:

- the mission authority
- the main risk console
- the primary enterprise audit view

### 3.2 Chronos

Chronos is the management control plane.

Its job is to:

- show projects, missions, task sessions, and mission seeds
- show approvals, bindings, and artifacts
- show execution state and blockers
- expose deterministic interventions
- provide accountability drill-down

Chronos should feel like the control tower.

It should not become:

- the default conversational front-end
- the only artifact viewer
- a replacement for mission authority

### 3.3 CEO UX

The CEO UX is the leadership decision surface.

Its job is to:

- receive high-level intent
- show waiting approvals
- show current company-level outcomes
- surface major exceptions

The CEO UX should feel like a strategic dashboard and approval inbox.

It should not expose low-level execution machinery by default.

## 4. Responsibility Table

| Responsibility | Presence Studio | Chronos | CEO UX |
| --- | --- | --- | --- |
| Natural language request intake | Primary | Secondary | Secondary |
| Slot filling and clarifications | Primary | Rare | Rare |
| Short plan display | Primary | Secondary | Summary only |
| Current work detail | Primary | Secondary | Minimal |
| Project overview | Secondary | Primary | Summary only |
| Mission seed management | Secondary | Primary | No |
| Approval queue | Secondary | Primary | Primary |
| Risk and runtime inspection | No | Primary | Summary only |
| Artifact delivery | Primary | Secondary | Summary only |
| Audit and evidence drill-down | No | Primary | Linked only |

## 5. Authority Boundaries

Surfaces should not directly own durable execution authority.

They must route control through backend authorities such as:

- `mission_controller`
- `agent-runtime-supervisor`
- `surface_runtime`

Surface code may:

- collect intent
- render state
- request deterministic actions

Surface code should not:

- mutate mission lifecycle directly
- invent separate approval models
- bypass policy or runtime authority

## 6. User Journey Alignment

The three-surface model should map cleanly to the enterprise loop:

```text
Intent
-> Presence Studio or CEO UX
-> Resolve and plan
-> Chronos for operational control and accountability
-> Result back to Presence Studio or CEO UX
-> Learn through memory systems
```

This preserves a simple human experience while keeping execution inspectable and governed.

## 7. Design Test

When introducing a new feature, ask:

1. Is this primarily conversational, operational, or executive?
2. Which surface should own the default experience?
3. Which surface should only link to or summarize it?
4. Does the action still flow through backend authority?

If those answers are unclear, the feature likely needs stronger surface separation.

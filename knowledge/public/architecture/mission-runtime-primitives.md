---
title: Mission Runtime Primitives
category: Architecture
tags: [architecture, runtime, mission, worker, coordination]
importance: 8
author: Ecosystem Architect
last_updated: 2026-04-05
---

# Mission Runtime Primitives

## 1. Purpose

Kyberion should not copy an entire lightweight multi-agent framework into its planning layer.

It should selectively adopt the lower-layer runtime primitives that help owner and worker agents coordinate bounded work.

The adopted primitives are:

- `WorkerAssignmentPolicy`
- `MissionCoordinationBus`
- `MissionWorkingMemory`

## 2. Design Rule

These primitives exist below governed planning and above physical execution.

They are **runtime helpers**, not constitutional authorities.

- Knowledge still defines process and outcomes.
- The compiler still defines execution contracts.
- Mission ownership still remains single-owner.
- The runtime only helps move bounded work between that owner and delegated workers.

## 3. WorkerAssignmentPolicy

Purpose:

- recommend which worker should receive a bounded task
- prefer matching capability and role
- penalize active lease pressure
- avoid overlapping scope conflicts

Kyberion use:

- mission follow-up fan-out
- review/remediation verification splits
- dependency-first dispatch for blocked mission work

## 4. MissionCoordinationBus

Purpose:

- exchange explicit messages between owner and workers
- separate transient coordination from durable mission state
- keep handoff/review/runtime notice traffic attributable

Kyberion channels:

- `task_contract`
- `handoff`
- `review`
- `runtime_notice`

This aligns with the single-owner, multi-worker model:

- workers communicate progress and handoffs
- owners accept or reject durable progress

## 5. MissionWorkingMemory

Purpose:

- store transient mission-local notes
- hold intermediate findings before durable promotion
- give the owner a structured synthesis surface

This is not a replacement for:

- promoted memory
- distill candidates
- governed knowledge

It is only for short-lived coordination context.

## 6. Work Loop Integration

`OrganizationWorkLoopSummary.runtime_design` now declares:

- `owner_model`
- `assignment_policy`
- `coordination.bus`
- `coordination.channels`
- `memory.store`
- `memory.scope`
- `memory.purpose`

This makes the runtime layer inspectable and replayable without giving the LLM authority over planning.

## 7. Boundary

The correct boundary is:

- LLM:
  - drafts
  - summarizes
  - proposes bounded work language
- Knowledge:
  - defines process and allowed outcomes
- Compiler:
  - binds contracts, targets, and governed structure
- Runtime primitives:
  - route bounded work
  - retain transient coordination context
- Executors:
  - perform physical changes and persist evidence

## 8. Non-Goals

Kyberion does not adopt:

- free-form agent handoff as the primary planning model
- coordinator sovereignty over task design
- shared memory as a substitute for knowledge
- queue completion as a substitute for mission completion

Those remain intentionally governed by the Kyberion control plane.

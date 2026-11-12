---
title: Mission Runtime Primitives
category: Architecture
tags: [architecture, runtime, mission, worker, coordination]
importance: 8
author: Ecosystem Architect
last_updated: 2026-10-05
kind: evergreen
---

# Mission Runtime Primitives

## 1. Purpose

Kyberion should not copy an entire lightweight multi-agent framework into its planning layer.

It should selectively adopt the lower-layer runtime primitives that help owner and worker agents coordinate bounded work.

The adopted primitives are:

- `WorkerAssignmentPolicy`
- `MissionCoordinationRecord`
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

## 4. MissionCoordinationRecord

Purpose:

- record what the mission owner told its workers (rework handoffs, review requests)
- keep owner-to-worker traffic attributable after the fact
- stay separate from durable mission state

It is a **record, not a delivery path**. Workers receive their task through the agent execution port; the owner dispatches and reviews directly. Nothing reads the record back at runtime and nothing acknowledges rows in it (the inbox / acknowledgement API of the former `MissionCoordinationBus` was retired 2026-11-12 — see `retired/README.md`). Code: `libs/core/mission/mission-coordination-record.ts` (`recordMissionCoordinationMessage`), stored append-only at `<mission dir>/coordination/bus.jsonl` (file name kept so existing missions stay readable).

Channels written today: `handoff`, `review`. `task_contract` and `runtime_notice` remain in the stored vocabulary only so ledgers written by earlier versions still parse.

This aligns with the single-owner, multi-worker model:

- the owner records the handoffs and review requests it sends
- the owner alone accepts or rejects durable progress

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
- `coordination.bus` (the declared record store; see §4). The value `mission_coordination_bus` and the four declared channels are the historical routing token and vocabulary; only `handoff` and `review` are written
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

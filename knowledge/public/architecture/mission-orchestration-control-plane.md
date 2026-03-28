---
title: Mission Orchestration Control Plane
kind: architecture
scope: repository
authority: reference
phase: [alignment, execution, review]
tags: [mission, orchestration, events, a2a, supervisor, control-plane]
owner: ecosystem_architect
---

# Mission Orchestration Control Plane

## Goal

Keep Kyberion conceptually simple:

- one durable `mission`
- one deterministic `mission_controller`
- many cooperating agents

while allowing flexible multi-agent orchestration through event-driven execution and API-shaped delegation.

## Core Principle

Kyberion separates three planes:

1. **Mission Control Plane**
   - owns mission lifecycle and durable state
   - implemented by `mission_controller`

2. **Orchestration Plane**
   - reacts to events
   - decides the next deterministic action
   - prewarms runtimes and emits A2A task requests

3. **Agent Work Plane**
   - executes delegated work through A2A
   - produces artifacts and follow-up events

## Single-Authority Rule

Only `mission_controller` may mutate mission-wide lifecycle state.

LLM agents:

- may propose
- may plan
- may review
- may implement

but they do not directly own mission state transitions.

## Event vs A2A

Kyberion uses two distinct communication mechanisms.

### Event

Use an event when the system needs to record or request a control-plane transition.

Examples:

- `mission_issue_requested`
- `mission_team_prewarm_requested`
- `mission_kickoff_requested`
- `mission_followup_requested`
- `mission_reconciliation_requested`
- `runtime_lease_remediation_applied`

Events are:

- append-only
- replayable
- auditable
- deterministic

### A2A

Use A2A when one agent asks another agent to perform work.

Examples:

- planner creates `PLAN.md`
- reviewer evaluates a task packet
- implementer produces a deliverable

A2A is:

- work delegation
- agent-to-agent
- non-deterministic in runtime/latency

## Runtime Ownership

All agent runtime creation should flow through `agent-runtime-supervisor`.

Callers should not independently spawn agent providers.

Allowed caller behavior:

- enqueue runtime prewarm request
- wait for prewarm result if needed
- emit A2A after runtime is ready

Disallowed target behavior:

- direct ad hoc provider spawn in surface code
- multiple workers racing to spawn the same agent instance

`agent-runtime-supervisor` is the runtime front door for:

- `ensure`
- `ask`
- `refresh`
- `restart`
- `stop`
- `shutdownAll`

`runtime-supervisor` remains the lower-level resource registry. The supervisor layer is the operational authority; the runtime registry is the physical snapshot.

## Recommended Flow

1. Surface receives sovereign intent.
2. Nerve returns either:
   - direct reply
   - `team_role` proposal
   - `mission_proposal`
3. Confirmation emits `mission_issue_requested`.
4. Orchestration worker issues mission through `mission_controller`.
5. Worker emits `mission_team_prewarm_requested`.
6. `agent-runtime-supervisor` prewarms required team roles.
7. Worker emits `mission_kickoff_requested`.
8. Planner receives A2A kickoff request.
9. Planner writes initial artifacts.
10. Worker emits `mission_followup_requested`.
11. Follow-up worker prewarms the required worker roles.
12. `NEXT_TASKS.json` tasks are delegated through A2A.
13. Mission state and task board reconcile from artifacts/events.
14. Owner summary is emitted to surface outboxes and control-plane observability.

## Why This Shape

This preserves simplicity:

- mission remains the main durable object
- controller remains deterministic

while preserving flexibility:

- multiple agents can participate
- event-driven retries are possible
- surfaces remain lightweight ingress/egress

## Current Repository Contracts

- event store:
  - `active/shared/coordination/orchestration/events/`
- orchestration observability:
  - `active/shared/observability/mission-control/orchestration-events.jsonl`
- task event observability:
  - `active/shared/observability/mission-control/task-events.jsonl`
- agent runtime prewarm:
  - `active/shared/coordination/agent-runtime/requests/`
  - `active/shared/coordination/agent-runtime/results/`
- runtime supervisor observability:
  - `active/shared/observability/mission-control/agent-runtime-supervisor-events.jsonl`
- A2A runtime delegation:
  - `libs/core/a2a-bridge.ts`
- generic surface outbox:
  - `active/shared/coordination/channels/<surface>/outbox/`

## Surface Closing Contract

Surfaces stay lightweight by using a shared outbox model.

- workers write deterministic surface updates into the generic outbox
- channel bridges or control surfaces render those updates
- delivery is decoupled from mission orchestration latency

Current surfaces:

- `slack`
- `chronos`

## Chronos Access Model

Chronos Mirror v2 is not a mission authority. It is a local control surface with two access levels:

- `readonly`
  - mapped to `chronos_operator`
  - may inspect mission health, runtime leases, recent events, and outbox state
  - may not mutate mission, runtime, or surface state
- `localadmin`
  - mapped to `chronos_localadmin`
  - may invoke deterministic control actions through backend controllers
  - may not bypass `mission_controller`, `agent-runtime-supervisor`, or `surface_runtime`

Chronos must never gain authority by directly overriding mission-wide roles from the UI layer.
The only valid model is:

1. Chronos authenticates as `readonly` or `localadmin`
2. route handlers validate the access level
3. handlers invoke deterministic backend controllers
4. backend controllers mutate state under their own explicit roles

This keeps the concept simple:

- Chronos is a surface
- `mission_controller` is the mission authority
- `agent-runtime-supervisor` is the runtime authority
- `surface_runtime` is the surface authority

This keeps the concept simple:

- one mission state machine
- one event-driven orchestration model
- one runtime supervisor
- one surface delivery contract

Chronos should also be read as part of the higher-order surface split:

- `Presence Studio`
  - conversational concierge surface
- `Chronos`
  - management control plane
- `CEO UX`
  - leadership approval and outcome surface

Reference:
- `knowledge/public/architecture/surface-responsibility-model.md`

## Migration Direction

Short term:

- surfaces emit orchestration events
- workers process one event at a time

Medium term:

- generic orchestration worker handles all channels
- mission task acceptance/review becomes event-driven too

Long term:

- render `mission -> events -> team roles -> runtime resources -> A2A tasks`
  as the canonical operational graph

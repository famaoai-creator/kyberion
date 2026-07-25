---
title: Agent Mission Control Model
category: Architecture
tags: [architecture, mission, agent, leases, observability, coordination]
importance: 9
author: Ecosystem Architect
last_updated: 2026-03-20
---

# Agent Mission Control Model

## 1. Goal

Define a control model where missions remain explainable, agents can collaborate safely, and runtime ownership is observable without falling back to opaque global state.

## 2. Core Principle

Kyberion does not execute "free-floating agents." It executes **missions** through agents.

- A **mission** is the durable contract.
- An **agent** is an actor that receives authority from a mission.
- A **runtime resource** is the physical execution substrate.
- A **lock** is only a short-lived mutex.
- A **lease** is a durable authority grant with scope, owner, and expiry.

## 3. Ownership Model

### 3.1 Mission Ownership

Each mission has exactly one **owner agent** at a time.

- The owner agent is the only actor allowed to:
  - update mission status
  - create checkpoints
  - verify or reject outcomes
  - finish/archive the mission
- Ownership is represented by a **mission lease**.

### 3.2 Task Collaboration

Missions may delegate work to multiple **worker agents**.

- Worker agents do not own the mission.
- Worker agents receive **task leases** scoped to a task contract.
- Worker outputs must flow back to the owner agent for accept/reject.

### 3.3 Observer Agents

Observer agents are read-mostly agents used for:

- review
- audit
- policy evaluation
- observability summarization

They never mutate mission state directly.

## 4. Control Layers

1. `mission-controller`
   - mission state machine
   - mission lease authority
   - mission lifecycle authority

2. `mission-orchestration-worker`
   - reacts to control-plane events
   - prewarms runtimes
   - emits A2A task delegation
   - reconciles artifacts back into mission state

3. `agent-runtime-supervisor`
   - runtime front door
   - spawn/reuse/ask/refresh/restart/stop
   - prewarm request processing
   - lease metadata projection to runtime resources

4. `agent-lifecycle`
   - logical agent runtime implementation
   - provider mediation and readiness

5. `runtime-supervisor`
   - physical execution resources
   - PTY / agent / service ownership
   - idle reaping and snapshots

6. `resource-lock`
   - file and registry mutex
   - short-lived exclusion only

7. `coordination-store`
   - task contracts
   - handoffs
   - reviews
   - agent mailboxes

8. `mission-working-memory`
   - transient mission-local notes
   - intermediate findings
   - owner synthesis inputs before durable promotion

9. `worker-assignment-policy`
   - bounded task-to-worker recommendation
   - lease-aware capability matching
   - dependency-first dispatch for blocked mission work

## 5. Lock vs Lease

### 5.1 Resource Lock

Use a lock when:

- the scope is small
- the duration is short
- the purpose is atomic exclusion

Examples:

- updating `registry.json`
- moving a queue item
- rotating a session state file

### 5.2 Mission Lease

Use a lease when:

- authority must be attributable
- work may last minutes or hours
- a stale holder must be recoverable

Examples:

- owner agent controlling a mission
- worker agent claiming a delegated task
- bridge consumer claiming a handoff artifact

## 6. Collaboration Pattern

Kyberion should use **single-owner, multi-worker** execution.

### 6.1 Single Owner

One owner agent has mission write authority.

This keeps:

- accountability clear
- rollback simple
- audit trails understandable

### 6.2 Multi Worker

Multiple worker agents may operate concurrently if their task leases do not conflict.

Worker agents must write only to:

- task-local outputs
- handoff artifacts
- review packets

They must not mutate mission state directly.

## 7. Coordination Storage Model

### 7.1 Mission-Local Coordination

Path:

- `active/missions/<tier>/<mission_id>/coordination/`

Purpose:

- task contracts
- lease claims
- worker handoffs
- owner review decisions

Recommended subdirectories:

- `tasks/`
- `claims/`
- `handoffs/`
- `reviews/`
- `events/`

### 7.2 Global Coordination

Path:

- `active/shared/coordination/`

Purpose:

- global discovery
- cross-mission agent mailboxes
- lease registry mirrors
- runtime presence summaries

Recommended subdirectories:

- `mailboxes/<agent_id>/`
- `missions/<mission_id>/`
- `leases/`
- `presence/`

## 8. Observability Model

Observability must answer four questions:

1. Which mission is in control?
2. Which agents are participating?
3. Which runtime resources are alive?
4. Why was a decision made?

### 8.1 Event Streams

Maintain append-only JSONL streams for:

- mission events
- task events
- lease events
- runtime events
- handoff events
- surface delivery events
- surface outbox remediation events

### 8.2 Required Event Fields

Each event should include:

- `ts`
- `event_id`
- `event_type`
- `mission_id`
- `task_id`
- `agent_id`
- `resource_id`
- `correlation_id`
- `causation_id`
- `decision`
- `why`
- `policy_used`
- `evidence`

### 8.3 Surface Outbox

Mission progress summaries and deterministic operator notices should not be emitted directly from workers to surfaces.

They should be written to:

- `active/shared/coordination/channels/slack/outbox/`
- `active/shared/coordination/channels/chronos/outbox/`

This keeps:

- orchestration asynchronous
- delivery retriable
- surface logic thin

## 9. Explainability Standard

Logs must be decision-centric, not just action-centric.

Bad:

- "lease denied"

Good:

- "lease denied because mission owner already holds active write authority for overlapping scope"

Every authority change should explain:

- who requested it
- who held it
- why it was accepted or denied
- what policy was used
- what the next expected action is

## 10. Migration Direction

### Phase 1

- keep existing global resource locks
- introduce explicit lease schemas
- define coordination directories and event contracts

### Phase 2

- move mission ownership from implicit focus/global state to explicit mission leases
- add task contracts and owner/worker review flow

### Phase 3

- render `mission -> agents -> tasks -> resources` in dashboards
- use event streams as the source of truth for operational reasoning
- close the loop from reconciliation summary to surface delivery through the generic outbox

## 11. Execution surface selection

Kyberion offers two execution surfaces for delegated work, plus a hybrid:

- **CLI subagent team mode** — subagents run inside the same CLI harness session (Claude Code Agent tool / Agent SDK `agents`), against the same CLI-independent contracts used everywhere else (task contracts, context packs, `task_result`).
- **agent-runtime (A2A bridge)** — the runtime model described in §3–§8 of this document: mission leases, runtime resources, coordination store, event streams.
- **Hybrid** — starts in one surface and escalates to the other mid-task.

This section gives a deterministic rubric so opus/sonnet/haiku reach the same routing decision from the same inputs, mirroring the axis/threshold format of [AUTONOMOUS_MAINTENANCE_JUDGMENT](../../../docs/developer/AUTONOMOUS_MAINTENANCE_JUDGMENT.ja.md) §1.

### 11.1 Axes and thresholds

Score each axis 0 (favors CLI team) to 3 (favors agent-runtime). Judged by the **max axis, not the sum** — one axis at 3 forces agent-runtime regardless of the others.

| Axis                   | 0 — CLI subagent team                                                  | 3 — agent-runtime (forces)                                                                      |
| ---------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Expected duration      | Completes within one CLI session (per-session, minutes)                | Spans multiple days or must survive the session ending                                          |
| Write volume           | Read-mostly (review, audit, investigation)                             | Write-heavy (multi-file edits, migrations, sustained mutation)                                  |
| Recovery requirement   | No restart-resume needed; losing the session loses nothing durable     | Must survive crash/restart — needs KD-03 event-sourced journal replay                           |
| Failure isolation      | Blast radius is one subagent's output, discardable on rejection        | A crash must not take down concurrent unrelated work (per-resource isolation)                   |
| Approval / kill-switch | Harness tool permission (allowlist, `canUseTool`) is sufficient        | Needs Kyberion-native gates: mission lease revocation, kill-switch, cross-session isolation     |
| Model diversity need   | Lens-diverse suffices (same model/provider, different vantage prompts) | True multi-provider best-of-N required to cancel systematic single-model bias → route via XP-07 |

### 11.2 Decision rule

- All axes ≤1 → **CLI subagent team mode**.
- Any single axis = 3 → **agent-runtime** (hard threshold; no averaging).
- Mixed 2s with no 3 → **hybrid**: start in CLI team mode, escalate to agent-runtime the moment a 3-condition appears (e.g., a read-mostly review spawns a write-heavy fix).
- **CLI-team choice and cross-provider choice are orthogonal**: "which execution surface" (this rubric) and "single-provider lens diversity vs. true multi-provider best-of-N" (the model diversity axis) compose independently — a CLI team task can still fan its judge step out to XP-07 best-of-providers when only the model diversity axis reads 3.

### 11.3 Caveats (apply even once the rubric picks CLI team)

- **Single-process blast radius**: all subagents in a CLI team share the orchestrating CLI process. A crash, OOM, or hang in the host session takes every in-flight subagent with it — there is no per-subagent runtime isolation the way agent-runtime provides per resource.
- **Harness-permission dependency**: CLI team governance rests on the harness's own tool-permission and approval mechanism, not a Kyberion-native kill-switch. Kyberion layers tier/approval gates on top (governed path), but cannot force-stop a CLI subagent the harness has already approved.

See [CLI_SUBAGENT_TEAM_PLAN (CT-01–04)](../../../docs/developer/improvement-plans-2026-07/CLI_SUBAGENT_TEAM_PLAN_2026-07-25.ja.md) for the implementation and [CROSS_PROVIDER_EXECUTION_PLAN (XP-07)](../../../docs/developer/improvement-plans-2026-07/CROSS_PROVIDER_EXECUTION_PLAN_2026-07-25.ja.md) for the model-diversity axis.

## 12. Non-Goals

This model does not attempt to:

- make every agent fully autonomous from mission governance
- allow concurrent mission-wide write authority
- replace audit with opaque metrics

The design goal is controlled autonomy with visible authority.

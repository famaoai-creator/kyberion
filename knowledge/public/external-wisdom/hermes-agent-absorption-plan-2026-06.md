---
title: Hermes Agent Absorption Plan 2026-06
category: External Wisdom
tags: [external-wisdom, hermes-agent, kanban, hooks, cron, plugins, skills, tool-gateway]
knowledge_type: explicit
intelligence_layer: methodology
importance: 8
author: Codex
last_updated: 2026-06-28
---

# Hermes Agent Absorption Plan 2026-06

## 1. Purpose

Re-evaluate Hermes Agent after its recent feature expansion and turn the useful
parts into a Kyberion implementation plan.

This is not a porting plan. Kyberion should absorb the coordination, scheduling,
extension, and surface-governance patterns that strengthen mission execution,
while keeping Kyberion's ADF, mission, data-tier, and actuator contracts
provider-neutral.

Analysis snapshot:

- upstream repository: `NousResearch/hermes-agent`
- inspected commit: `fae920642aa0237459dd3c55b72adbacc88c21aa`
- inspected source: official docs plus local repository clone under
  `active/shared/tmp/hermes-agent-src`

## 2. What Changed Since The 2026-05 Scan

The 2026-05 landscape scan correctly identified Hermes Skills and Kanban as the
main patterns to watch. The 2026-06 scan shows that Hermes has moved from "a
useful agent shell with a board" toward a fuller local control plane:

| Area | Current Hermes capability | Kyberion implication |
|---|---|---|
| Kanban | durable multi-board task kernel, worker lanes, run history, structured handoff metadata, dashboard, event stream, crash/stale detection | promote Kyberion task/session state into a board-like kernel with attempt history and visible handoffs |
| Worker lanes | board owns lifecycle truth; workers only execute and must terminate via complete/block protocol | keep mission/task as authoritative, make agents/actuators executor lanes |
| Persistent goals | standing goal loop with completion contracts, subgoals, wait barriers for background processes | map into Kyberion goal contracts and long-running mission gates, not a separate chat-only loop |
| Cron | unified scheduled-task tool, skill-backed jobs, no-agent script jobs, `wakeAgent`, `context_from`, provider/model fail-closed behavior | harden Kyberion scheduled operations and chronos-style tasks around cost, idle checks, and context chaining |
| Hooks | gateway hooks, plugin hooks, shell hooks, transform hooks, approval observation, shell allowlist and doctor | add a governed hook/event registry for surface and actuator lifecycle events |
| Plugins | opt-in general plugins plus provider/backend/platform plugin classes; project plugins disabled by default | refine Kyberion extension policy around trusted capability bundles and project-local code |
| Skills | progressive disclosure, external skill dirs, skill bundles, slash-command dispatch, env/config declaration, staged write approval | evolve Kyberion capability bundles into reusable, surface-addressable task profiles |
| Tool Gateway | per-tool gateway/direct routing, status and cost visibility, gateway not a lock-in | implement provider/tool routing policy without tying Kyberion to Nous billing or endpoints |

## 3. Absorb These Patterns

### 3.1 Durable board kernel with run attempts

Hermes Kanban's strongest pattern is that tasks and runs are separate. A task is
the durable work item. A run is one execution attempt, with outcome, log pointer,
summary, metadata, and event references.

Kyberion should add this shape to mission/task execution:

- task state remains the durable truth, not the worker process
- each attempt gets a `run_id`, owner, start/end time, outcome, verification
  evidence, log/trace references, and structured handoff metadata
- retries read previous attempts to avoid repeating failed paths
- human/manual completion creates a synthetic run so history remains complete
- events carry `run_id` where applicable so Chronos can group them by attempt

Candidate implementation targets:

- `src/mission-control/*`
- `libs/core/*task*`
- `active/projects/*/state/`
- Chronos trace/task views under `presence/displays/chronos-mirror-v2/`

### 3.2 Worker lanes as executor contracts

Hermes separates `Board = canonical lifecycle` from `Worker lane = executor`.
That is directly compatible with Kyberion's mission-control model.

Kyberion should define lane contracts for:

- local actuator lane
- reasoning backend lane
- provider CLI lane, for example Codex, Claude, Gemini, or Agy
- browser/desktop lane
- human-review lane

Each lane should declare:

- `assignee_id` / owner
- spawn or invocation mechanism
- workspace/data-tier scope
- allowed toolsets or actuators
- termination protocol: `complete`, `block`, `needs_review`, `failed`
- heartbeat and max-runtime expectations
- handoff metadata schema

Do not let a worker lane mutate mission-wide state directly. It should emit
events and task outcomes through the mission/task contract.

### 3.3 Human-in-the-loop board UX

Hermes' board is useful because the same kernel is visible from CLI, slash
command, dashboard, and workers. Kyberion should make Chronos show this clearly:

- task columns: `triage`, `todo`, `ready`, `running`, `blocked`, `done`,
  `archived`
- task drawer with comments, dependencies, current run, prior runs, and evidence
- worker visibility: active worker, last heartbeat, runtime, current trace
- "review-required" or equivalent blocked convention
- event stream grouped by attempt
- nudge/retry/unblock controls with approval-aware confirmations

This should improve operator UX more than adding another delegation primitive.

### 3.4 Scheduled task hardening

Hermes Cron has several patterns Kyberion should absorb into Chronos/scheduled
missions:

- provider/model snapshot on job creation
- fail closed when a scheduled job would silently inherit a different provider
  or model
- no-agent jobs for script-only checks and heartbeats
- `wakeAgent` pre-run gate to avoid spending model tokens when no state changed
- `context_from` chaining for scheduled workflows
- per-job toolset scope
- prompt-injection and credential-exfiltration scan at create/update time
- local-only output retention even when delivery is suppressed

Candidate implementation targets:

- `knowledge/product/orchestration/schedule-delivery-protocol.md`
- Chronos task scheduler/runtime files
- surface delivery code that already handles final-response delivery and trace
  receipts

### 3.5 Governed hook surface

Hermes now has lifecycle hooks that can observe, transform, inject context, or
block tool calls. Kyberion should support the pattern, but with stronger policy:

- hooks are registered through a typed Kyberion hook registry
- events are stable names, for example `surface.message.received`,
  `agent.turn.start`, `actuator.call.pre`, `actuator.call.post`,
  `approval.requested`, `approval.resolved`, `surface.reply.transform`
- blocking hooks must declare policy scope and approval requirements
- transform hooks must emit before/after receipts, redaction state, and owner
- shell/process hooks are opt-in, allowlisted, and checked by a `doctor` command
- project-local hooks are disabled unless the project policy explicitly enables
  them

Candidate implementation targets:

- new core hook registry under `libs/core/`
- surface runtime integration near final-response and tool-result paths
- api-guard / secret-guard policy checks
- Chronos event viewer for hook decisions

### 3.6 Plugins and capability bundles

Hermes' plugin system is valuable less because it is Python, more because it
separates extension classes:

- general tools/hooks/commands
- gateway platform adapters
- image/video/TTS/STT backends
- memory providers
- context engines
- model providers
- plugin-bundled skills

Kyberion should not copy the plugin runtime, but should refine its extension
taxonomy:

- capability bundle manifest
- actuator/provider backend manifest
- surface adapter manifest
- memory/context provider manifest
- governance fields: trust level, data-tier access, approval behavior, update
  source, verification command

This should feed existing registries rather than create a separate plugin truth.

### 3.7 Skill bundles as task profiles

Hermes Skills now include progressive disclosure, external directories, skill
bundles, slash commands, env/config declarations, and staged write approval.

Kyberion's equivalent should be "task profiles" or "capability bundles":

- concise index entry for discovery
- full instructions loaded only when selected
- optional references/templates/scripts/assets
- required environment/config declarations routed through secret/config guard
- approval-gated writes for agent-created or agent-edited bundles
- bundle composition for common workflows, for example `incident-response`,
  `release-prep`, `presentation-authoring`, `surface-debugging`

This maps better to Kyberion than copying a `~/.hermes/skills` layout.

### 3.8 Tool gateway routing policy

Hermes Tool Gateway is provider-specific, but the design pattern is portable:
tool routing should be explicit per capability, observable, and reversible.

Kyberion should model:

- direct provider route
- managed gateway route
- local actuator route
- fallback route
- cost/usage visibility
- auth source and renewal mode
- "do not silently switch" guard for unattended jobs

This belongs in provider/actuator policy and execution receipts, not inside ADF.

### 3.9 Video generation as a capability bundle, not a backend

Hermes' most useful video pattern is not a single renderer. It is a compact
surface that separates:

- the user-facing intent
- the selected provider or backend
- the production recipe or skill
- the final media delivery path

In practice, Hermes treats video as a first-class capability in three ways:

- `video_generate` is a single tool surface with backend-agnostic routing
- providers are registered dynamically and selected from configuration
- generated media is delivered through the same attachment-routing layer as
  other artifacts

Kyberion should absorb that shape directly, but keep the contract split
explicit:

- `video-generation-adf` for prompt-driven generated clips
- `narrated-video-brief` / `video-composition-adf` for composed or narrated
  videos
- capability bundles or skills for repeatable video recipes such as manim-style
  explainers or ASCII video

Implementation targets:

- keep the public contract provider-neutral
- move provider choice into registries and policy, not into the ADF
- keep delivery routing aware of `video` as a native attachment type
- keep skill bundles as the place for repeatable production recipes

Exit criteria:

- a video request can be resolved without knowing the concrete backend at
  authoring time
- composed/narrated video stays separate from prompt-driven generation
- delivery surfaces treat video as a native artifact rather than a text-only
  link

## 4. Do Not Copy These Parts

Do not copy:

- Hermes' single-host SQLite Kanban store as Kyberion's authoritative state.
  Kyberion should use its project/mission/task state model and may add a local
  cache or projection only where useful.
- Nous Tool Gateway billing, endpoints, or subscription assumptions.
- Hermes-specific tool names such as `kanban_complete` in ADF or mission
  contracts. Keep them behind adapters.
- unrestricted shell hooks. Any process-backed hook must be explicit,
  allowlisted, traceable, and revocable.
- project-local plugin execution by default.
- chat-only persistent goal state as the main Kyberion durable work model.

## 5. Implementation Plan

### P0: Update Architecture Contracts

Goal: make the target architecture explicit before implementation.

Tasks:

- link this document from the product roadmap and provider-native bridge docs
- extend the harness capability and adapter registry with Hermes-derived
  capability classes beyond the existing Kanban entry:
  - durable board kernel
  - scheduled-task runner
  - hook pipeline
  - plugin/capability bundle surface
  - tool-routing gateway
- define receipt fields for board task attempts, scheduled jobs, hook decisions,
  and tool-route decisions

Exit criteria:

- registry entries exist and name fallbacks/approval behavior
- docs name the canonical Kyberion owner for each absorbed pattern

### P1: Mission Task Attempt Model

Goal: add run/attempt semantics to Kyberion task execution.

Tasks:

- define `TaskAttempt` / `TaskRun` schema
- emit attempt lifecycle events from mission task execution
- store structured handoff metadata and verification evidence
- add synthetic attempts for manual completion/blocking
- expose attempt history in Chronos

Exit criteria:

- a retried task shows multiple attempts with outcomes and evidence
- Chronos can answer who tried what, when, why it failed, and what unblocks it

### P2: Chronos Board UX

Goal: make durable work supervision visible to operators.

Tasks:

- add board columns and task drawer
- show comments, dependencies, owner, current run, prior runs, and trace links
- add `block`, `unblock`, `request review`, `nudge`, and `archive` controls
- group events by `run_id`
- surface active worker and heartbeat state

Exit criteria:

- an operator can recover a blocked or stale task without reading raw logs
- review-required work is visible without parsing final assistant text

### P3: Scheduled Task V2

Goal: reduce cost surprises and make recurring operations deterministic.

Tasks:

- snapshot provider/model/tool route at scheduled-job creation
- fail closed on provider/model drift unless explicitly repinned
- add no-agent script job path
- add `wakeAgent`-style pre-run gate
- add `context_from` chaining
- scan job prompts and scripts for secret-exfiltration and prompt-injection
  patterns

Exit criteria:

- a watchdog can run without model calls when nothing changed
- scheduled jobs never silently switch to a different provider/model
- failed jobs preserve local evidence and deliver a clear operator alert

### P4: Governed Hooks

Goal: give Kyberion surfaces controlled extension points without turning hooks
into hidden policy.

Tasks:

- define stable hook event names and callback result schema
- add hook registry with trust and data-tier metadata
- implement observer, blocker, context-injector, and transformer hook classes
- add allowlist/revoke/doctor commands for shell-backed hooks
- show hook decisions in trace/Chronos

Exit criteria:

- a hook can block unsafe actuator use with an auditable reason
- transform hooks cannot silently rewrite final output without a receipt
- project-local hooks stay off unless policy enables them

### P5: Capability Bundles And Tool Routing

Goal: turn reusable procedures and provider routes into governed product
features.

Tasks:

- define a Kyberion capability-bundle manifest
- support progressive disclosure: index -> full bundle -> reference files
- gate agent-created bundle writes behind approval
- add provider/tool route policy and receipt fields
- expose route status in operator surfaces

Exit criteria:

- users can invoke a named bundle across CLI/message/browser surfaces
- direct/gateway/local routes are visible before unattended execution
- bundle updates are reviewable and reversible

## 6. Validation Strategy

Add scenario tests or probes for:

- mission task with two attempts, one blocked and one completed
- manual completion that creates a synthetic attempt
- scheduled job that fails closed after provider/model drift
- no-agent scheduled watchdog with no delivery on empty stdout or
  `wakeAgent=false`
- hook that blocks a dangerous actuator call and records the decision
- transform hook that redacts output and produces a before/after receipt
- capability bundle discovery from at least two surfaces
- tool route decision captured in an execution receipt

## 7. Source Links

- Hermes Kanban:
  <https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban>
- Hermes Kanban worker lanes:
  <https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-worker-lanes>
- Hermes Scheduled Tasks:
  <https://hermes-agent.nousresearch.com/docs/user-guide/features/cron>
- Hermes Event Hooks:
  <https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks>
- Hermes Plugins:
  <https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins>
- Hermes Skills:
  <https://hermes-agent.nousresearch.com/docs/user-guide/features/skills>
- Hermes Persistent Goals:
  <https://hermes-agent.nousresearch.com/docs/user-guide/features/goals>
- Hermes Tool Gateway:
  <https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-gateway>
- Hermes repository:
  <https://github.com/NousResearch/hermes-agent>

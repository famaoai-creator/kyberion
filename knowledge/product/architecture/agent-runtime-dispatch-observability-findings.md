---
title: Agent Runtime Dispatch Observability Findings
kind: architecture
scope: repository
authority: reference
phase: [alignment, execution, review]
tags: [agent-runtime, dispatch, a2a, supervisor, observability, evidence]
owner: ecosystem_architect
---

# Agent Runtime Dispatch Observability Findings

This note summarizes the observed behavior of mission team startup and
agent dispatch in Kyberion, based on the `MSN-DISPATCH-TEST-002` flow and
its supporting runtime traces.

The key takeaway is simple:

- `create/start/team` prepare mission state
- `staff/prewarm` brings live runtimes up through `agent_runtime_supervisor`
- `dispatchMissionNextTasks(...)` routes work through `a2a_bridge`
- the returned agent response is not automatically persisted unless the
  mission flow writes it to evidence

## 1. What the mission controller does

The mission controller owns the durable mission lifecycle:

- create mission state
- start the mission
- compose the team
- record task intent
- checkpoint
- verify
- distill
- finish

In the observed flow, `create` and `start` did **not** send anything to the
agent runtime supervisor. They only updated mission state and focus metadata.

## 2. What staff / prewarm does

`staff` and `prewarm` are the first steps that actually involve
`agent_runtime_supervisor`.

Observed behavior:

- a prewarm request file is written under
  `active/shared/coordination/agent-runtime/requests/`
- the supervisor daemon is started as a detached managed process
- the request is consumed and a result file is written under
  `active/shared/coordination/agent-runtime/results/`
- the supervisor emits `agent_runtime_prewarm_requested`,
  `agent_runtime_prewarm_started`, and `agent_runtime_prewarm_completed`

This is runtime provisioning, not task dispatch.

## 3. What dispatch does

`dispatchMissionNextTasks(...)` performs the first task-level routing.

Observed behavior:

- a task is promoted from `planned` to `requested`
- the orchestration layer emits `task_issued`
- the mission ledger emits `MISSION_FOLLOWUP_DISPATCHED`
- `a2a_bridge.route(...)` is used to send the task request to the target
  agent
- the target agent may be auto-spawned or reused if already live

## 4. What the agent runtime actually did

In the observed dispatch path, `implementation-architect` did receive
`agent_runtime_ask_requested` and `agent_runtime_ask_completed` events.

That means:

- the agent runtime was alive long enough to answer
- the dispatch did not fail at the route layer
- the response existed at least transiently

However, later probes showed:

- `status = null`
- `runtimes = []`

So the live runtime was no longer registered when we tried to inspect it
again.

## 5. Why the response was hard to recover

The current routing path returns the agent response in memory, but the mission
flow does not automatically persist that response as a durable evidence file.

That creates a gap:

1. the agent answers
2. the live runtime may later disappear
3. unless the response is written immediately, the mission only keeps the
   route event and not the body of the answer

This is the main operational gap observed in the dispatch test.

## 6. Most likely causes of runtime disappearance

The traces do **not** show a clear explicit `shutdown` event for
`implementation-architect`.

The most plausible explanations are:

- the runtime was reaped by idle cleanup
- the provider process exited after answering
- the runtime did not remain attached long enough for a later status probe

In other words, the observed failure mode is closer to
**short-lived runtime + missing immediate persistence** than to a broken
route request.

## 7. Stable operational rule

For team-composing missions, treat response capture as a first-class step.

Recommended minimum sequence:

1. create
2. start
3. team
4. staff / prewarm
5. record task
6. board update
7. dispatch / A2A
8. capture agent response into mission evidence
9. checkpoint
10. verify
11. distill
12. finish

If the mission expects the dispatched agent to produce evidence, that evidence
should be written to mission-local storage immediately after the response is
received.

## 8. Design implication

The runtime supervisor is the liveness authority.
The mission board is the durable work state.
The A2A bridge is the delivery path.
The evidence directory is the durable response store.

These are related, but they are not the same thing.

## 9. Related docs

- [`mission-lifecycle-and-record-keeping.md`](./mission-lifecycle-and-record-keeping.md)
- [`mission-orchestration-control-plane.md`](./mission-orchestration-control-plane.md)
- [`agent-runtime-observability-model.md`](./agent-runtime-observability-model.md)
- [`agent-runtime-work-coordination-map.md`](./agent-runtime-work-coordination-map.md)
- [`work-coordination-platform.md`](../orchestration/work-coordination-platform.md)

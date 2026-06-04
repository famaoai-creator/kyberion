---
title: Agent Runtime and Work Coordination Map
category: Architecture
tags: [architecture, agent-runtime, kanban, work-item, transport, a2a, coordination]
importance: 8
author: Ecosystem Architect
last_updated: 2026-06-04
---

# Agent Runtime and Work Coordination Map

This document places `agent_runtime`, `Work Coordination Platform`, `agmsg`-style transport, and `a2a_fanout` on one page.

The short version is:

- `agent_runtime` keeps live agents alive and observable
- `Work Coordination Platform` keeps work durable
- `agmsg`-style transport moves short messages between live agents
- `a2a_fanout` creates multiple viewpoints for reasoning and critique

## 1. One-Page View

```text
Intent / Mission Request
        |
        v
Organization Profile
        |
        v
Mission Team Composition
        |
        v
Agent Runtime Supervisor
        |
        v
Work Coordination Platform
  (WorkItem / Board / Track)
        |
        +----------------------+
        |                      |
        v                      v
Optional Message Transport   Wisdom A2A Ops
(agmsg-like, short-lived)     (fanout / critique / synthesis)
        |                      |
        +----------+-----------+
                   |
                   v
        Task Execution / Evidence / Audit
```

## 2. Responsibility Split

| Layer | Owns | Does not own |
|---|---|---|
| `agent_runtime` | agent spawn, refresh, restart, stop, provider/session observability, runtime health | durable work board state, task claims, fanout semantics |
| `Work Coordination Platform` | work items, board views, claim/handoff/release, track state, review queue | provider session state, process liveness, message transport details |
| `agmsg`-style transport | short agent-to-agent messages, delivery mode, lightweight notifications | runtime lifecycle, board ownership, mission authority |
| `a2a_fanout` / `cross_critique` | parallel viewpoints, adversarial review, synthesis of competing hypotheses | durable board state, runtime ownership, transport persistence |

## 3. How They Relate in Kyberion

Kyberion keeps these layers separate on purpose:

1. The mission and organization layers decide *what kind of work this is*.
2. Team composition decides *which roles should exist*.
3. `agent_runtime` decides *which live agents can actually run those roles right now*.
4. The work board decides *what is still pending, claimed, blocked, or handed off*.
5. Transport decides *how short-lived messages move between live agents*.
6. `a2a_fanout` decides *when the work needs multiple viewpoints instead of one answer*.

The observed dispatch flow adds one more practical rule:

- a routed A2A request can succeed even if the live runtime is no longer
  available later
- the response body should therefore be written to mission evidence as soon as
  it is received

## 4. Practical Interpretation

### `agent_runtime`

Use this when the question is:

- Is the agent live?
- What provider/model/session is it using?
- Should it be refreshed or restarted?
- Which runtime owns it?

This is the layer described in [`agent-runtime-observability-model.md`](./agent-runtime-observability-model.md).

### `Work Coordination Platform`

Use this when the question is:

- What work is open?
- Who owns it?
- Has it been claimed or handed off?
- Which track or board should show it?

This is the layer described in [`work-coordination-platform.md`](../orchestration/work-coordination-platform.md).

### `agmsg`-style transport

Use this when the question is:

- How do two live agents exchange a short instruction or acknowledgement?
- How do we avoid putting every interaction into the board?

This is transport, not ownership.

### `a2a_fanout`

Use this when the question is:

- Do we need multiple independent viewpoints?
- Do we need critique before synthesis?
- Is one agent likely to miss something important?

This is a reasoning operator, not a runtime and not a board.

## 5. Decision Rules

- If the problem is about liveness, refresh, or session state, use `agent_runtime`.
- If the problem is about work tracking, use the board / Kanban / track layer.
- If the problem is about short-lived agent messaging, use transport.
- If the problem is about divergent reasoning, use `a2a_fanout`.

## 6. Why This Matters

The three concepts are easy to blur:

- a board can look like a runtime
- a transport can look like a task system
- a fanout can look like a board action

Kyberion keeps them separate so that:

- live agents can be restarted deterministically
- work can survive retries and handoffs
- transport can stay lightweight
- multi-view reasoning can stay explicit

## 7. Related Docs

- [`agent-runtime-observability-model.md`](./agent-runtime-observability-model.md)
- [`mission-orchestration-control-plane.md`](./mission-orchestration-control-plane.md)
- [`work-coordination-platform.md`](../orchestration/work-coordination-platform.md)
- [`agent-communication-layer-model.md`](./agent-communication-layer-model.md)
- [`mission-team-composition-model.md`](./mission-team-composition-model.md)

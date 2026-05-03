---
title: Agent Communication Layer Model
category: Architecture
tags: [architecture, agents, prompt, subagent, a2a, bridge, protocol]
importance: 8
author: Ecosystem Architect
last_updated: 2026-05-04
---

# Agent Communication Layer Model

Kyberion uses several distinct communication patterns to move work between reasoning, delegation, and coordination layers.

The simplest way to reason about them is:

- `prompt` for one-shot reasoning
- `subagent` for delegated bounded work
- `agent coordination` for multi-agent or multi-surface collaboration

Transport can be local or remote. That is a separate axis.

The practical question is one level higher:

- given a user intent, which execution shape should own it
- and if it is not `prompt`, how much structure is needed to keep the work bounded

## 1. The three execution shapes

### 1.1 Prompt

`prompt` is a single request/response interaction.

Use it when the work is:

- short
- easy to inspect
- low-risk to retry
- not worth decomposing into its own task

Typical examples:

- summarize evidence
- transform structured text
- produce a short analysis
- normalize a prompt or contract

In the codebase, prompt-style reasoning is most visible in:

- [`libs/core/intent-contract.ts`](/Users/famao/kyberion/libs/core/intent-contract.ts)
- [`scripts/run_pipeline.ts`](/Users/famao/kyberion/scripts/run_pipeline.ts)

Rule of thumb:

- default to prompt mode unless the task clearly benefits from autonomous decomposition

### 1.2 Subagent

`subagent` means work is delegated to a child agent that can reason or act with bounded autonomy.

Use it when the work is:

- exploratory
- multi-step
- better decomposed by an autonomous worker
- expensive to keep in the main loop

Typical examples:

- repair an invalid ADF contract
- decompose a task plan into implementation steps
- participate in a meeting flow
- delegate a complex diagnostic or review pass

In the codebase, subagent-style delegation is visible in:

- [`libs/core/claude-agent-reasoning-backend.ts`](/Users/famao/kyberion/libs/core/claude-agent-reasoning-backend.ts)
- [`libs/core/codex-cli-reasoning-backend.ts`](/Users/famao/kyberion/libs/core/codex-cli-reasoning-backend.ts)
- [`libs/core/adf-repair-agent.ts`](/Users/famao/kyberion/libs/core/adf-repair-agent.ts)
- [`libs/core/task-executor.ts`](/Users/famao/kyberion/libs/core/task-executor.ts)
- [`scripts/meeting_participate.ts`](/Users/famao/kyberion/scripts/meeting_participate.ts)

Rule of thumb:

- use subagent mode only when autonomy or parallelism is worth the overhead

### 1.3 Agent coordination

`agent coordination` is the higher-order pattern where multiple agents, surfaces, or runtimes exchange envelopes, state, or delegated tasks.

Use it when the work crosses:

- roles
- surfaces
- lifecycles
- trust boundaries
- protocols

Typical examples:

- A2A envelopes
- mission delegation
- assistant compiler requests/results
- bridge startup and reconcile flows
- managed surface lifecycle

In the codebase, agent coordination is visible in:

- [`scripts/run_a2a.ts`](/Users/famao/kyberion/scripts/run_a2a.ts)
- [`libs/core/assistant-compiler-request.ts`](/Users/famao/kyberion/libs/core/assistant-compiler-request.ts)
- [`libs/core/mission-orchestration-worker.ts`](/Users/famao/kyberion/libs/core/mission-orchestration-worker.ts)
- [`scripts/mission_controller.ts`](/Users/famao/kyberion/scripts/mission_controller.ts)
- [`scripts/surface_runtime.ts`](/Users/famao/kyberion/scripts/surface_runtime.ts)

Rule of thumb:

- if the work needs a durable envelope, a state transition, or a trust boundary, treat it as coordination rather than plain reasoning

## 2. The transport axis

The execution shape is not the same as the transport.

Kyberion’s transport axis is usually one of:

- `local`
  - same machine, same workspace, same control plane
- `remote`
  - another process, host, tenant, or surface reached over a protocol
- `bridge`
  - a managed connector that normalizes an external channel into Kyberion state
- `protocol`
  - a structured envelope or SDK contract used across runtimes

Examples:

- `prompt` can be local or remote
- `subagent` is often local today, but can be backed by a remote protocol
- `agent coordination` can be local file-based envelopes, local process handoff, or a remote bridge/API

## 3. Intent routing layer

The execution shape should be decided from the intent, not guessed from the implementation detail.

This layer sits above the intent contract and below mission or surface orchestration.
It answers:

- should the work stay single-shot
- should a child agent own part of the work
- or should the work become a coordinated multi-agent flow

### 3.1 Routing rubric

Use the smallest shape that can still finish safely.

| Signal | Default shape |
|---|---|
| one deliverable, low risk, easy to inspect | `prompt` |
| exploratory, multi-step, repair-heavy, or parallelizable | `subagent` |
| durable state transition, ownership handoff, or trust boundary | `agent coordination` |

Score the intent with four questions:

| Question | What it detects |
|---|---|
| `scope` | one artifact vs many artifacts vs durable flow |
| `autonomy` | whether the work needs independent decomposition |
| `boundary` | whether mission, surface, runtime, or trust boundaries are crossed |
| `fanout` | whether parallel workers or cross-critique would materially improve the result |

### 3.2 Routing output

The routing result should be treated as a small decision envelope, not a new ADF.
It is additive metadata on top of existing intent contracts.
The governed defaults live in `knowledge/public/governance/work-policy.json`, so operators can tune routes without changing the contract shape.

Recommended fields:

```json
{
  "kind": "agent-routing-decision",
  "intent_id": "generate-report",
  "source_text": "今週の進捗レポートを作って",
  "mode": "subagent",
  "scope": "single_artifact",
  "autonomy": "medium",
  "boundary_crossing": false,
  "fanout": "review",
  "owner": "report-drafting-agent",
  "delegates": ["fact-check-agent", "editor-agent"],
  "artifact_count": 1,
  "stop_condition": "A governed report draft exists and the owner has accepted it.",
  "rationale": "The request is review-heavy and benefits from a bounded drafting worker plus a lightweight review pass."
}
```

The key rule is:

- `prompt` means no child ownership is needed
- `subagent` means child ownership is useful, but the work still fits inside one governed task
- `agent coordination` means the work has crossed into durable orchestration

### 3.3 Boundary triggers

Prefer `agent coordination` when any of these are true:

- the work must survive retries or restarts
- the work needs mission ownership, task leases, or audit-trail semantics
- the work crosses a surface, runtime, or trust boundary
- the work needs multiple legitimate viewpoints to avoid a bad single-pass answer

Prefer `subagent` when any of these are true:

- the work needs exploration before the final answer is clear
- the work can be decomposed into bounded child tasks
- the main loop would be too expensive to keep all the context in

Prefer `prompt` when none of the above is necessary.

## 4. Mapping to current Kyberion systems

| Layer | What it is | Representative files |
|---|---|---|
| Prompt | one-shot reasoning, short synthesis, structured conversion | [`libs/core/intent-contract.ts`](/Users/famao/kyberion/libs/core/intent-contract.ts), [`scripts/run_pipeline.ts`](/Users/famao/kyberion/scripts/run_pipeline.ts) |
| Subagent | delegated bounded work, autonomous repair, decomposition | [`libs/core/claude-agent-reasoning-backend.ts`](/Users/famao/kyberion/libs/core/claude-agent-reasoning-backend.ts), [`libs/core/adf-repair-agent.ts`](/Users/famao/kyberion/libs/core/adf-repair-agent.ts), [`libs/core/task-executor.ts`](/Users/famao/kyberion/libs/core/task-executor.ts) |
| Agent coordination | envelopes, mission handoff, bridge lifecycle, runtime management | [`scripts/run_a2a.ts`](/Users/famao/kyberion/scripts/run_a2a.ts), [`libs/core/assistant-compiler-request.ts`](/Users/famao/kyberion/libs/core/assistant-compiler-request.ts), [`scripts/mission_controller.ts`](/Users/famao/kyberion/scripts/mission_controller.ts), [`scripts/surface_runtime.ts`](/Users/famao/kyberion/scripts/surface_runtime.ts) |
| Bridge / API | external surface ingress and delivery | [`satellites/slack-bridge/src/index.ts`](/Users/famao/kyberion/satellites/slack-bridge/src/index.ts), [`satellites/imessage-bridge/src/index.ts`](/Users/famao/kyberion/satellites/imessage-bridge/src/index.ts), [`satellites/voice-hub/server.ts`](/Users/famao/kyberion/satellites/voice-hub/server.ts) |
| Protocol / mediator | structured cross-runtime transport | [`libs/core/acp-mediator.ts`](/Users/famao/kyberion/libs/core/acp-mediator.ts), [`libs/core/mission-orchestration-worker.ts`](/Users/famao/kyberion/libs/core/mission-orchestration-worker.ts) |

## 5. Decision guide

Ask these questions in order:

1. Can the work finish in one prompt?
   - If yes, use `prompt`.
2. Does it need autonomous decomposition or repair?
   - If yes, use `subagent`.
3. Does it cross ownership, runtime, or trust boundaries?
   - If yes, use `agent coordination`.
4. Is the communication local or remote?
   - Choose the transport separately from the execution shape.

## 6. Practical examples

### Example: ADF reasoning step

For a short synthesis step, keep it on prompt mode.

For exploratory analysis or review-heavy work, opt in to subagent mode explicitly.

### Example: Mission delegation

Mission ownership stays in the control plane.

The delegated worker can be a subagent, but the mission itself is an agent coordination problem.

### Example: Messaging bridge startup

A bridge activation request is not just reasoning.

It is:

- intent resolution
- bridge manifest reconciliation
- surface lifecycle management
- external channel delivery

That makes it agent coordination with a bridge transport.

## 7. Operating rule

If you need a one-line rule:

**Use prompt for one-shot thinking, subagent for bounded autonomous work, and agent coordination for everything that crosses a durable boundary.**

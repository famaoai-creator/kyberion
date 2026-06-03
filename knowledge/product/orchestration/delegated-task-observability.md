---
title: Delegated Task Observability
category: Orchestration
tags: [orchestration, delegation, observability, subagent]
importance: 8
author: Ecosystem Architect
last_updated: 2026-05-03
---

# Delegated Task Observability

Hermes-style subagent delegation is useful only if it is visible.

Kyberion therefore treats delegated work as a traced event stream:

- when a delegated task starts, record a start event
- when it completes, record the completion result
- when it fails, record the failure reason

## 1. Why

Delegation can otherwise become invisible, especially when a backend
spawns an autonomous sub-agent and returns only a textual report.

Observability gives Kyberion:

- accountability
- replayability
- debugging context
- evidence for later learning

## 2. Record Shape

A delegated task trace should capture:

- `trace_id`
- owner
- instruction
- optional context or context reference
- backend name
- status transition
- completion summary or error

## 3. Storage

Delegation traces are append-only JSONL records under
`active/shared/observability/delegations.jsonl`.

That keeps them near the runtime observability surface without turning
them into durable mission state.

## 4. Usage Rule

Use delegated-task traces for:

- repair agents
- autonomous subagent invocation
- other short-lived reasoning offloads that need evidence

Do not use them as a replacement for mission evidence or permanent memory.


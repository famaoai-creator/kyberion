---
title: Subagent Observability Model
category: Architecture
tags: [architecture, delegation, observability, subagent]
importance: 7
author: Ecosystem Architect
last_updated: 2026-05-03
---

# Subagent Observability Model

Kyberion supports delegated reasoning work, but delegated work should
remain inspectable.

## Model

There are three distinct layers:

1. **delegation request**
2. **subagent execution**
3. **delegation trace**

The request is the intent to offload work.
The execution is the backend's private activity.
The trace is the observable record of the offload.

## Boundary

Subagent execution should not be confused with mission ownership.

- the owner keeps mission authority
- the subagent performs bounded work
- the trace captures what was delegated and how it ended

## Practical Impact

This allows Kyberion to:

- explain why a subagent was called
- understand whether the delegation succeeded
- inspect which backend handled the work
- keep short-lived delegation visible without inflating durable mission state

The operational record is described in
[`delegated-task-observability.md`](../orchestration/delegated-task-observability.md).


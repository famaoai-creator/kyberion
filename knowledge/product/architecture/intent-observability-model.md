---
title: Intent-First Observability Model
category: Architecture
tags: [architecture, observability, intent, surface, chronos]
importance: 9
author: Ecosystem Architect
last_updated: 2026-03-29
---

# Intent-First Observability Model

## 1. Purpose

Kyberion should feel simple from the outside while remaining explainable from the inside.

The observability model must therefore track the user-facing flow:

```text
Intent -> Slot -> Plan -> Execution -> Outcome
```

This is the trace shape that should be visible in Chronos, Presence Studio, and durable evidence streams.

## 2. The Five Layers

### 2.1 Intent

Capture:

- raw utterance
- source surface
- normalized request label
- routing confidence

Question answered:

- what did the human ask for?

### 2.2 Slot

Capture:

- required fields
- optional fields
- missing fields
- follow-up questions
- approvals still needed

Question answered:

- what information was still needed before work could continue?

### 2.3 Plan

Capture:

- standard intent selected
- template or task kind selected
- short human-readable plan
- whether fallback or generative planning was used

Question answered:

- how did Kyberion decide to approach the request?

### 2.4 Execution

Capture:

- direct reply, browser session, task session, or mission
- active state
- approval transitions
- actuator steps
- evidence and artifacts

Question answered:

- what is running right now, and where is it blocked?

### 2.5 Outcome

Capture:

- final answer
- artifact paths and types
- concise result summary
- failure reason if any
- suggested next action

Question answered:

- what came out, and what can the user do next?

## 3. UX Mapping

### Presence Studio

Default view:

- intent
- current plan
- current state
- latest result

Expanded view:

- work detail
- browser task detail
- artifact download

### Chronos

Default view:

- work needing attention
- open work
- current state
- latest artifact or result

Expanded view:

- execution trace
- approvals
- evidence
- intervention points

## 4. Recommended Event Fields

Each explainable event should include:

- `trace_id`
- `surface`
- `intent_type`
- `work_shape`
- `status`
- `summary`
- `result_shape`
- `artifact_refs`
- `ts`

Optional fields:

- `slot_missing`
- `plan_outline`
- `approval_required`
- `policy_decision`
- `error_code`

## 5. Storage Model

User-facing surfaces should summarize the trace.

Durable artifacts should live under governed observability paths such as:

- `active/shared/observability/channels/`
- `active/shared/observability/mission-control/`
- mission-local coordination and evidence paths

The same work item may therefore appear in:

- a short surface summary
- a durable task session or mission record
- a deeper observability event stream

## 6. Design Rule

The system should never force users to understand:

- raw ADF
- actuator names
- mission ledgers
- low-level runtime supervisor details

But it must always preserve enough structured evidence that operators can reconstruct:

- what was asked
- how it was understood
- what plan was chosen
- what actually ran
- what result or failure occurred

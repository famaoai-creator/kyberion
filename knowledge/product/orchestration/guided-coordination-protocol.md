---
title: Guided Coordination Protocol
category: Orchestration
tags: [orchestration, protocol, coordination, brief, preflight]
importance: 9
author: Codex
last_updated: 2026-04-30
---

# Guided Coordination Protocol

This protocol defines the shared operating shape for repeated, outcome-driven work.
It is the common layer for flows that are not one-shot answers, but also should not be modeled as a fresh custom pipeline every time.

Typical fits include:

- live meetings
- presentations and briefing packs
- narrated videos and launch assets
- booking, scheduling, and service coordination
- onboarding and environment setup
- proposal and decision-support work

## Core Principle

Do not encode the process inside each ad hoc brief.
Encode the process once, then attach case-specific payload to it.

The shared shape is:

```text
request -> shared coordination brief -> domain overlay -> preflight -> execution plan -> result -> review
```

## Shared Layers

### 1. Request Capture

Preserve the user's original request and extract the known facts.

What belongs here:

- the goal
- the target audience or counterpart
- the deadline or time window
- the approval boundary
- the expected outcome

### 2. Shared Coordination Brief

Create a reusable brief that answers the universal questions:

- What is the objective?
- What kind of coordination work is this?
- What information is missing?
- What decisions are blocked until preflight?
- What is the approval boundary?

This brief is not the final domain artifact.
It is the common front door for repeated work.

### 3. Domain Overlay

Attach a domain-specific overlay only after the shared brief is clear.

Examples:

- meeting role and authority boundary
- slide theme and audience fit
- booking site preference and payment policy
- video publish policy and visual style
- schedule move constraints

The overlay should narrow the work shape, not replace the shared flow.

### 4. Preference Profile

Persist reusable defaults in governed knowledge, not in code.

Examples:

- `meeting-operations-profile`
- `presentation-preference-profile`
- `booking-preference-profile`
- `narrated-video-preference-profile`

These profiles hold recurring defaults such as question sets, style hints, routing preferences, and approval policies.

### 5. Preflight

Keep preflight short.
Ask only the questions that materially change the work shape, the authority boundary, or the highest-risk choice.

Preflight should decide:

- whether the request can proceed
- which domain overlay applies
- which default profile should be used
- whether approval is required before execution

### 6. Execution Plan

Compile the shared brief and the domain overlay into an execution plan.

The plan should specify:

- the chosen actuator or workflow
- the expected outputs
- the guardrails and exit criteria
- the review or follow-up step

### 7. Result And Review

Return the concrete result, then identify reusable preferences or protocol improvements.

Do not mutate personal or organizational memory silently.
Propose reuse candidates separately.

## Anti-Patterns

- Writing the whole workflow into each individual brief
- Hard-coding question sets in code when the knowledge layer can store them
- Repeating the same approval rules in every domain-specific document
- Treating the brief as the workflow itself
- Letting renderers or actuators decide the coordination shape

## Extension Rule

When a new repeated workflow appears, ask first:

1. Can it reuse the shared coordination brief?
2. Can it be modeled as a domain overlay?
3. Can the default behavior live in a preference profile?
4. Can the workflow be expressed as one more specialization instead of a new one-off path?

If the answer is yes, extend the shared protocol rather than creating a new bespoke flow.


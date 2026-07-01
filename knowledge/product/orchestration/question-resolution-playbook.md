---
title: Question Resolution Playbook
category: Orchestration
tags: [question-resolution, intent, preflight, knowledge, governance]
importance: 8
author: Kyberion
last_updated: 2026-07-01
---

# Question Resolution Playbook

`QuestionResolver` is the governed intake layer that turns an intent into a
minimal set of questions, instead of treating clarification as an ad hoc
prompt.

## What it asks

The resolver asks only for the slots that change execution shape, authority
boundary, or runtime prerequisites.

Typical slots:

- goal or target
- execution scope
- approval boundary
- service or runtime availability
- the minimum source artifact required to proceed

## Where the knowledge lives

The resolver does not hard-code the reusable questions in code.
The canonical sources are:

- `knowledge/product/governance/question-resolution-policy.json`
- intent catalog intake requirements in `knowledge/product/governance/standard-intents.json`
- existing coordination profiles such as meeting, presentation, booking, and narrated video profiles

The code layer merges these sources at runtime.

## How it learns

Clarification answers should flow into mission-local evidence first.
Then they may be promoted into durable knowledge through the existing
distillation / operator-learning pathways when repeated patterns are observed.

That keeps the loop:

1. ask the smallest useful question set
2. record the answer with traceability
3. reuse the answer when the same context returns
4. promote the pattern only after it is stable

## Operational rule

If a question does not change the work shape, do not ask it in preflight.
If the same question keeps reappearing, encode it in the policy layer rather
than copying it into every surface.


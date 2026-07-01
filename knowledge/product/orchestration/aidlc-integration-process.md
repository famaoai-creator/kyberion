---
title: AIDLC Integration Process
category: Orchestration
tags: [aidlc, question-resolution, intent, preflight, knowledge, governance]
importance: 8
author: Kyberion
last_updated: 2026-07-01
---

# AIDLC Integration Process

When Kyberion incorporates AIDLC-style workflows, treat the process as a
governed intake and clarification loop rather than a standalone chat helper.

## Integration sequence

Use this sequence when a new repeated workflow is introduced:

1. capture the user intent
2. clarify only the slots that change execution shape, authority boundary, or runtime prerequisites
3. store the clarified result in mission-local evidence and project/track state
4. execute through the governed pipeline or actuator path
5. verify the output against the stated success condition
6. learn from repeated patterns and promote only stable ones into durable knowledge

## Question sources

`QuestionResolver` should compile questions from these sources in order:

- intent intake requirements
- clarification policy
- reusable domain profiles

Do not hard-code recurring question sets in the implementation when the same
shape can live in knowledge.

## Knowledge placement

Keep the layers separate:

- mission-local evidence for the immediate run
- project/track state for current operational context
- durable knowledge only after repetition or promotion criteria are met

This avoids duplicating the same clarification pattern across code, docs, and
runtime logs.

## Practical rule

If a question does not change the work shape, do not ask it in preflight.
If a question keeps reappearing across runs, promote it into policy or profile
knowledge instead of copying it into each surface.


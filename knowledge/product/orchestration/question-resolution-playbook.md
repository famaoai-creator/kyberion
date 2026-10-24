---
title: Question Resolution Playbook
category: Orchestration
tags: [question-resolution, intent, preflight, knowledge, governance, customer-decision]
importance: 8
author: Kyberion
last_updated: 2026-10-24
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

## Whose question is it (customer judgment)

A question raised while a mission task is executing has one of three owners.
Classify it before asking anyone (`classifyQuestionDecision` in
`libs/core/question-resolver.ts`):

| Class                                     | When                                                                                                                                   | What happens                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| ours                                      | Technical choices the customer neither sees nor pays for (library, file layout, test strategy), and missing inputs our side can supply | Decide it, or put it in `needs` as a clarification                                                 |
| `customer_judgment`                       | A product choice the customer will see (behavior, wording, screens, scope priority)                                                    | Return it in `customer_decisions` with our proposal (`proposed_value`) and go on with the proposal |
| `customer_judgment` + `requires_customer` | Money, contract, release, change requests (`customer_judgment.requires_customer_topics` in the policy)                                 | Return it in `customer_decisions` with `requires_customer: true` and no value; the task waits      |

How a customer judgment travels (CD-09):

1. The worker returns `customer_decisions[]` (question, item, key, proposal,
   optional options, `requires_customer`, rationale, topic) in its
   `task_result`. A topic the policy reserves for the customer always waits,
   whatever the worker said.
2. The worker strips them from the result and records them in the task's own
   consumer lock in the mission's decision case
   (`knowledge/confidential/<tenant>/decisions/<case>/consumers/`). Public
   mission evidence and the shared WorkItem store get ids and counts only,
   never the question or the values.
3. The operator collects them into a draft agenda
   (`pnpm kyberion customer-decision draft --tenant <t> --case <c> --from-tasks --customer <slug>`)
   and submits and sends it as usual. `status` lists pending proposals and
   tasks waiting for the customer.
4. The task completes on our proposal. If the customer later decides
   differently, the respond sweep files one rework WorkItem.
5. A `requires_customer` question blocks the task (WorkItem `blocked`,
   `blocked_reason: awaiting_customer_decision`). When the customer's
   decision is confirmed by the operator, the hold is marked resolved on the
   WorkItem; `pnpm mission resume <MISSION_ID>` re-runs the task on the
   decided value.

A mission without a decision case records nothing to a ledger: a
`requires_customer` question becomes an ordinary clarification need (the task
blocks as `needs_input`), and any other customer judgment goes on with the
proposal.

## Where the knowledge lives

The resolver does not hard-code the reusable questions in code.
The canonical sources are:

- `knowledge/product/governance/question-resolution-policy.json`
- intent catalog intake requirements in `knowledge/product/governance/standard-intents.json`
- existing coordination profiles such as meeting, presentation, booking, and narrated video profiles
- [`AIDLC Integration Process`](./aidlc-integration-process.md)

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

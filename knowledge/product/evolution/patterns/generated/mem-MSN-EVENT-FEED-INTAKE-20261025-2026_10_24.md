---
record_id: mem-MSN-EVENT-FEED-INTAKE-20261025-2026_10_24
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-EVENT-FEED-INTAKE-20261025-2026_10_24
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-24T17:52:37.762Z
source_branch: feat/event-feed-intake-20261025
source_commit: 543583338290be1f8060c6bb62f12066edfaf19d
---

# Resolve timeout races with a sentinel, not undefined

When a Promise.race timeout branch resolves to undefined/null, downstream code misreads it as a shape or parse error and the recorded failure names the wrong cause. Resolve the race with a unique sentinel so 'timed out' stays distinguishable from 'answered but malformed', then record the timeout itself as the failure.

## Applicability

- mission
- mission:MSN-EVENT-FEED-INTAKE-20261025

## Reusable Steps

1. When a Promise
2. race timeout branch resolves to undefined/null, downstream code misreads it as a shape or parse error and the recorded failure names the wrong cause
3. Resolve the race with a unique sentinel so 'timed out' stays distinguishable from 'answered but malformed', then record the timeout itself as the failure

## Expected Outcome

## Rule

When a `Promise.race` guards a provider or service call with a timeout, the timeout branch must resolve to a dedicated sentinel (a `Symbol` or a tagged object), never to `undefined`/`null`.

## Why

`undefined` is also what many downstream decoders produce for an absent or malformed payload. When the timeout wins the race and yields `undefined`, the result flows into the same path as a malformed answer and the durable failure state, the warn log and any coverage/health surface all report 'bad shape' — while the real cause (a wedged provider) is nowhere. Operators then debug the payload contract instead of provider health.

## Pattern

```ts
const TIMED_OUT = Symbol('fetch-timeout');
const raw = await Promise.race([
  serviceCall(input),
  new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), TIMEOUT_MS)),
]);
if (raw === TIMED_OUT) {
  /* record 'fetch timed out after Ns' as the failure */
}
```

Two properties fall out for free and are worth keeping: the abandoned call's late rejection is already handled by the settled race (no unhandled rejection, no crash), and every consumer of the failure — state file, poll result, coverage row, warn log — carries the real cause.

## Test

Fake timers plus a never-resolving call assert the failure says 'timed out' rather than the malformed-result message; without the sentinel the same test produces the wrong diagnostic.

Origin: MSN-EVENT-FEED-INTAKE-20261025 self-review found the defect in the dot feed poller; fixed in commit 543583338.

## Evidence

- active/missions/public/MSN-EVENT-FEED-INTAKE-20261025/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-EVENT-FEED-INTAKE-20261025/evidence/test-report.md
- active/missions/public/MSN-EVENT-FEED-INTAKE-20261025/evidence/implementation-report.md

## Artifacts

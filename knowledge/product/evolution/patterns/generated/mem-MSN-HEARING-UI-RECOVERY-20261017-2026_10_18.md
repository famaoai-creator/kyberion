---
record_id: mem-MSN-HEARING-UI-RECOVERY-20261017-2026_10_18
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-HEARING-UI-RECOVERY-20261017-2026_10_18
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-18T02:11:10.899Z
source_branch: qa/hearing-ui-published
source_commit: 1288b5777bbc60d57104db36ae10e5e6cf093c74
---

# Recover uncertain decisions only from exact current proof

A recovery read must fence earlier mutation responses and match the authenticated operation receipt to a freshly validated current record before clearing a pending guard.

## Applicability

- mission
- mission:MSN-HEARING-UI-RECOVERY-20261017

## Reusable Steps

1. A recovery read must fence earlier mutation responses and match the authenticated operation receipt to a freshly validated current record before clearing a pending guard

## Expected Outcome

## When to apply

Use this rule when a browser mutation can commit despite a lost response.

## Recovery protocol

Persist only the minimal operation ID, version, requirements revision, scenario, session and scope before sending the mutation. Do not store private answers or infer a receipt for legacy markers. Offer an explicit bounded read-only recovery action; absent or denied proof remains unknown, while superseded proof remains historical. Neither outcome authorizes an automatic resend or downstream execution.

Starting recovery must retire the original POST settlement as well as older reads. Guard every callback by scope, session, generation and exact marker ownership. A late successful POST or rejection cannot overwrite a newer recovery result. Read the current record, then verify the authenticated exact-operation receipt, canonical actor identity and revision before unlocking. Downstream handoff still independently validates current state.

## Verification

Use canonical actor constructors and actual durable route responses through the client harness. Two independently invented mocks can agree on the wrong identity format. Reproduce late POST success/rejection after timeout, scope changes, stale generations, storage failures, missing proof and superseded proof. Keep ordinary test children neutral; mission and stub flags belong to governance calls and otherwise contaminate unrelated fixtures. Preserve per-shard logs so interrupted verification cannot be reported as passing.

## Limits

A client harness is not rendered browser E2E. Report missing browser binaries and denied IPC separately; do not elevate or infer nonexecution from missing receipts.

## Evidence

- active/missions/public/MSN-HEARING-UI-RECOVERY-20261017/evidence/lessons-source.md
- active/missions/public/MSN-HEARING-UI-RECOVERY-20261017/evidence/implementation-report.md
- active/missions/public/MSN-HEARING-UI-RECOVERY-20261017/evidence/test-report.md
- active/missions/public/MSN-HEARING-UI-RECOVERY-20261017/evidence/REVIEW-execution-implement.md

## Artifacts

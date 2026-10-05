---
record_id: mem-MSN-DURABLE-INTAKE-20261005-2026_10_05
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-DURABLE-INTAKE-20261005-2026_10_05
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T07:27:42.421Z
source_branch: feat/durable-conversation-execution-20261005
source_commit: 30053acbf58e23889c644063fa459a23b9c73641
---

# Fence durable intake, execution ownership and verified reporting separately

Durable front-desk execution needs atomic scoped intake, fresh execution ownership, revision-bound authority and artifact readback; report retries must never repeat work.

## Applicability

- mission
- mission:MSN-DURABLE-INTAKE-20261005

## Reusable Steps

1. Durable front-desk execution needs atomic scoped intake, fresh execution ownership, revision-bound authority and artifact readback; report retries must never repeat work

## Expected Outcome

Persist the server-resolved principal, tenant, organization, project, request revision and return conversation with the pending dispatch under one write boundary. Make WorkItem creation unique atomically, and distinguish a genuinely new lease from replay of an existing lease before executing. Bind each approved action to the exact request and configured execution contract, and recheck authority before effects and before publishing a result. A worker completion statement is insufficient: verify the expected artifact bytes and digest and read them back before projecting work completion. Keep delivery receipts separate so a failed conversation projection retries reporting, not execution; quarantine uncertain effects instead of retrying them. When a durable transcript gains execution fields, fence older writers with a new record version so they cannot silently drop queued work. A single configured deterministic candidate needs no model call; future judgment may rank only already-authorized candidates and cannot grant authority or substitute for result evidence.

## Evidence

- active/missions/public/MSN-DURABLE-INTAKE-20261005/evidence/implementation-report.md
- active/missions/public/MSN-DURABLE-INTAKE-20261005/evidence/test-report.md
- active/missions/public/MSN-DURABLE-INTAKE-20261005/evidence/REVIEW-execution-implement.md

## Artifacts

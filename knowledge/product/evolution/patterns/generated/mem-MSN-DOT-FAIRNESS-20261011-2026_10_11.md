---
record_id: mem-MSN-DOT-FAIRNESS-20261011-2026_10_11
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-DOT-FAIRNESS-20261011-2026_10_11
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-11T15:41:15.768Z
source_branch: fix/dot-effect-ownership-fairness-20261011
source_commit: 3149517ea106b5278b7b1c45ebe425d7f2a0f9c9
---

# Persist effect ownership and scheduling progress across execution boundaries

A timeout ends waiting, not necessarily execution. Retain unresolved target ownership independently of leases and task status, fence subsequent dispatches, and persist scheduling progress before awaiting work.

## Applicability

- mission
- mission:MSN-DOT-FAIRNESS-20261011

## Reusable Steps

1. A timeout ends waiting, not necessarily execution
2. Retain unresolved target ownership independently of leases and task status, fence subsequent dispatches, and persist scheduling progress before awaiting work

## Expected Outcome

Acquire attempt-bound ownership of a declared target atomically with the work claim. Preserve the original target and tenant scope through timeout, lease expiry, archive, metadata updates, and restart. Check unresolved ownership both when admitting proposals and when claiming queued work, including proposals from the same agent or a higher-priority agent. At trusted pipeline dispatch boundaries, recheck the current attempt, lease, and operational halt state before starting another operation.

Settle ownership only through the matching trusted execution outcome or governed human reconciliation. Human recovery should reload the authenticated, version-bound approval inside the same mutation fence as the ownership/status transition, preserving effect-defining metadata. Archive, process death, and an abort request do not establish that an external effect stopped.

For serial executor fairness, persist the last-served identity before awaiting work and derive the next eligible identity from the current ordered set. This preserves continuation across process restarts and membership changes without abandoning per-agent caps or tenant checks.

Validate these properties with isolated real-store and process-restart experiments, not only mocked return values. Recorded evaluations changed repeated scheduling from AAAAAA to ABCABC. After a timeout, the already-running delayed write still completed, while conflicting queued work and later pipeline writes were prevented. An isolated authenticated-human recovery fixture then allowed conflicting work to proceed after reconciliation.

Limits: this approach cannot cancel an operation already dispatched. Cross-agent target protection requires declared targets. Persistent serial fairness does not reserve globally unique turns across concurrent sweeps or guarantee wall-clock response deadlines. Trusted worker completion evidence is not independent verification of external effects.

## Evidence

- active/missions/public/MSN-DOT-FAIRNESS-20261011/evidence/behavior-evaluation.md
- active/missions/public/MSN-DOT-FAIRNESS-20261011/evidence/test-report.md
- active/missions/public/MSN-DOT-FAIRNESS-20261011/evidence/implementation-report.md

## Artifacts

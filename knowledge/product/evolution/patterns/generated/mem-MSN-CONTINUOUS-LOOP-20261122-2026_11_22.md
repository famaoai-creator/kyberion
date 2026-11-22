---
record_id: mem-MSN-CONTINUOUS-LOOP-20261122-2026_11_22
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CONTINUOUS-LOOP-20261122-2026_11_22
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-22T14:35:55.593Z
source_branch: feat/continuous-loop-20261122
source_commit: 3443f9f49587d7a19f5fa8cc3c8634c9ea65d979
---

# Fence recurring collectors by attempt and charter authority

Persist launch and termination evidence independently from the permission to use a collected observation.

## Applicability

- mission
- mission:MSN-CONTINUOUS-LOOP-20261122

## Reusable Steps

1. Persist launch and termination evidence independently from the permission to use a collected observation

## Expected Outcome

A managed recurring collector should reserve its run and process identity before effects, bind snapshots to the reserved attempt, and revalidate the current charter at admission. Where a run cannot prove its effects, keep the exact attempt held until worker termination is recorded and an authenticated operator approves reconciliation. Confirmed pre-effect failures may retry at cadence. A temporary observation hold should leave independent rules and already-owned work eligible.

## Evidence

- active/missions/public/MSN-CONTINUOUS-LOOP-20261122/evidence/implementation-report.md
- active/missions/public/MSN-CONTINUOUS-LOOP-20261122/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-CONTINUOUS-LOOP-20261122/evidence/test-report.md

## Artifacts

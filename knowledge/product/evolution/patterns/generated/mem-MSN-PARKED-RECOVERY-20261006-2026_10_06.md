---
record_id: mem-MSN-PARKED-RECOVERY-20261006-2026_10_06
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-PARKED-RECOVERY-20261006-2026_10_06
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-06T14:01:42.311Z
source_branch: feat/parked-diagnostic-recovery-20261006
source_commit: a0476461dca45fd1b8e1bee05b10c45e1ebf7589
---

# Parked diagnostic recovery requires retained negative evidence and explicit human transitions

Keep termination distinct from execution authority; preserve retained evidence, immutable terminal receipts, and fresh authenticated UI state.

## Applicability

- mission
- mission:MSN-PARKED-RECOVERY-20261006

## Reusable Steps

1. Keep termination distinct from execution authority; preserve retained evidence, immutable terminal receipts, and fresh authenticated UI state

## Expected Outcome

Recovery of an approved but undispatched diagnostic must prove absence from every retained action, WorkItem, lease, event and output history; missing or malformed history denies recovery. Revalidate current owner and scope inside shared dispatch, coordination, transcript and output fences. Publish the immutable transcript tombstone before action decline so a killed writer can reconcile the same receipt, preserving the old approval. Enable a separately approved replacement UUID only after authoritative terminal readback. Browser clients must preserve HTTP status even when error JSON decoding fails, clear recovery identities on 401/403, and restore keyboard focus when confirmation controls are replaced. Real-process crash and race tests should retain exact isolated-root and command guards while using bounded random fixture paths to avoid filename limits in deeply nested worktrees. Distinguish production build, readiness gates, focused runtime tests, full-suite outcomes and hosted CI; run source-provenance tests after a normal source commit.

## Evidence

- active/missions/public/MSN-PARKED-RECOVERY-20261006/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-PARKED-RECOVERY-20261006/evidence/REVIEW-contract_authoring-ux-contract.md
- active/missions/public/MSN-PARKED-RECOVERY-20261006/evidence/test-report.md

## Artifacts

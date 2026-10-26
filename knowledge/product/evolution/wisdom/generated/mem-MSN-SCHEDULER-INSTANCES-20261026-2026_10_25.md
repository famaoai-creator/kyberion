---
record_id: mem-MSN-SCHEDULER-INSTANCES-20261026-2026_10_25
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-SCHEDULER-INSTANCES-20261026-2026_10_25
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-25T17:52:24.181Z
source_branch: feat/scoped-autonomous-loop-20261026
source_commit: e6e9a3f85e3bd43dd9ebf22747b4403d8ce4742c
---

# Namespace scheduler ownership by canonical checkout

Use one stable service identity per physical checkout and keep legacy global migration explicit.

## Hint Scope

mission

## Trigger Phrases

- Derive scheduler service, log and task names from the canonical physical repository root and pin that root in the service environment. Route install, status, start, stop and uninstall through the same instance specification. Keep old global registrations opt-in for management and migration. Partition enabled job ownership explicitly before starting multiple schedulers, then verify two live processes and prove stopping one leaves the other executing.

## Recommended References

- active/missions/public/MSN-SCHEDULER-INSTANCES-20261026/evidence/implementation-report.md
- active/missions/public/MSN-SCHEDULER-INSTANCES-20261026/evidence/test-report.md
- active/missions/public/MSN-SCHEDULER-INSTANCES-20261026/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-SCHEDULER-INSTANCES-20261026/evidence/implementation-report.md
- active/missions/public/MSN-SCHEDULER-INSTANCES-20261026/evidence/test-report.md
- active/missions/public/MSN-SCHEDULER-INSTANCES-20261026/evidence/REVIEW-execution-implement.md

## Artifacts

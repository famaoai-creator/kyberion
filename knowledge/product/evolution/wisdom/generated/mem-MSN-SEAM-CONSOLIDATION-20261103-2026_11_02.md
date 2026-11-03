---
record_id: mem-MSN-SEAM-CONSOLIDATION-20261103-2026_11_02
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-SEAM-CONSOLIDATION-20261103-2026_11_02
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-11-03T04:49:35.187Z
source_branch: refactor/seam-consolidation-20261103
source_commit: 4272c2997472e03822b4f4a9ce13fc7062767d16
---

# Keep provider lifecycle and resolution consistent across catalogs and execution

Use one registration lifecycle, explicit auto-selection rules, and caller regressions so provider removal and builtin registration have the same meaning throughout the runtime.

## Hint Scope

mission

## Trigger Phrases

- When a provider seam has derived router caches, invalidate them on both registration and removal. Register builtins through the same seam as extensions, and make catalog, list, get and reset describe the same providers. Automatic selection must use an eligible declared default or a unique eligible candidate; provider ID order is not a preference policy. Keep domain eligibility checks shared across legacy and governed selection routes, while preserving egress and explicit-choice constraints. Verify removal through the public facade and test throwing or reentrant lifecycle observers. Declaration and multiplicity checks are necessary but do not prove execution consistency.

## Recommended References

- active/missions/public/MSN-SEAM-CONSOLIDATION-20261103/evidence/implementation-report.md
- active/missions/public/MSN-SEAM-CONSOLIDATION-20261103/evidence/test-report.md
- active/missions/public/MSN-SEAM-CONSOLIDATION-20261103/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-SEAM-CONSOLIDATION-20261103/evidence/implementation-report.md
- active/missions/public/MSN-SEAM-CONSOLIDATION-20261103/evidence/test-report.md
- active/missions/public/MSN-SEAM-CONSOLIDATION-20261103/evidence/REVIEW-execution-implement.md

## Artifacts

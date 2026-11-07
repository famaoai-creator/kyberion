---
record_id: mem-MSN-CORE-SCOPE-INTEGRATION-20261108-2026_11_07
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CORE-SCOPE-INTEGRATION-20261108-2026_11_07
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-07T16:49:41.010Z
source_branch: refactor/core-placement-20261107
source_commit: 1d042d119ad3a1bfda01f6da0371998c022690f2
---

# Authorization integrations preserve exact ceilings and one policy snapshot

Schema-aligned deny rules, policy availability and exact capability fingerprints must remain fail-closed during scope refactors.

## Hint Scope

mission

## Trigger Phrases

- Validate unknown fields and empty reasons before evaluating narrowing declarations. Explicit roles refuse I/O when policy is missing or corrupt. Use one lazy policy snapshot for narrowing, base permission and structural mkdir checks. An exact read-only archive scope must reject namePrefixExact expansion as well as write, append, mkdir and metadata lists. Test malformed custody by overriding actual scope fields and asserting the specific diagnostic. Freeze source and run focused boundary tests without concurrent state writers before claiming leak-free verification.

## Recommended References

- active/missions/public/MSN-CORE-SCOPE-INTEGRATION-20261108/evidence/implementation-report.md
- active/missions/public/MSN-CORE-SCOPE-INTEGRATION-20261108/evidence/test-report.md
- active/missions/public/MSN-CORE-SCOPE-INTEGRATION-20261108/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-CORE-SCOPE-INTEGRATION-20261108/evidence/implementation-report.md
- active/missions/public/MSN-CORE-SCOPE-INTEGRATION-20261108/evidence/test-report.md
- active/missions/public/MSN-CORE-SCOPE-INTEGRATION-20261108/evidence/REVIEW-execution-implement.md

## Artifacts

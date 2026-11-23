---
record_id: mem-MSN-DATA-VAULT-PARTITION-20261123-2026_11_23
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-DATA-VAULT-PARTITION-20261123-2026_11_23
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-23T08:21:56.783Z
source_branch: refactor/data-vault-cache-floor-20261123
source_commit: bf6c5bfdacbd99e887f19dff57f8f3991f655053
---

# Retire a flat store by moving it onto a partitioned floor, not by attributing entries

Moving the unpartitioned data vault onto the tier/tenant-partitioned cache floor made ownership follow from the path and removed the key-based attribution code. The transition still needs a legacy claim, so offboarding leaves no tenant data behind in the old directory.

## Hint Scope

mission

## Trigger Phrases

- Lessons from MSN-DATA-VAULT-PARTITION-20261123:

1. Survey real usage before choosing between partitioning and retiring. The vault's only writer (executeServicePresetCached) had no callers, so folding it into active/shared/cache/<tier>/<tenant|shared>/ was cheaper than redesigning a separate store. Ownership then follows from the path.
2. A store move needs a transition claim. Offboarding (tenant and project scope) must still claim tenant-keyed entries left in the legacy directory until its retention entry expires them; otherwise offboarding reports zero traces while tenant data remains.
3. A project offboarding without a filter must resolve the project's single lineage tenant, or fail closed, for every tenant-partitioned subtree it touches. Claiming only the shared partition silently leaves single-tenant data behind.
4. Values that come from a governed scope must keep their constraints when they become path segments. Admitted project ids may contain ':', so they need a deterministic segment encoding shared by the writer and offboarding, and an admitted call must be pinned to the admission's write_tier.
5. A per-entry TTL enforced only at read time is a data-minimisation regression; add an audited sweep that expires entries by their own expiresAt.
6. Isolation claims need one test with real secure-io and tier-guard on a temporary KYBERION_ROOT (the hearing-storage-boundary pattern); mocked secure-io proves nothing about tenant scope.

## Recommended References

- active/missions/public/MSN-DATA-VAULT-PARTITION-20261123/evidence/implementation-report.md
- active/missions/public/MSN-DATA-VAULT-PARTITION-20261123/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-DATA-VAULT-PARTITION-20261123/evidence/test-report.md

## Evidence

- active/missions/public/MSN-DATA-VAULT-PARTITION-20261123/evidence/implementation-report.md
- active/missions/public/MSN-DATA-VAULT-PARTITION-20261123/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-DATA-VAULT-PARTITION-20261123/evidence/test-report.md

## Artifacts

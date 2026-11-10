---
record_id: mem-MSN-CONCEPT-REGISTRY-20261109-2026_11_09
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CONCEPT-REGISTRY-20261109-2026_11_09
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-09T03:18:36.103Z
source_branch: feat/concept-registry-20261109
source_commit: 336d252c26700c278e908747a33d5d6f0054c407
---

# Retiring a document: separate lifecycle key, no recency credit, one canonical pointer

When docs are only ever added, vocabulary drifts; make retirement explicit and machine-checked, and never let the act of retiring a doc make it look fresher to retrieval.

## Hint Scope

mission

## Trigger Phrases

- Kyberion concept drift (2026-11) came from additive-only docs written by agents with local context while gates checked form, not meaning. Lessons: (1) Retirement is a distinct frontmatter key (`doc_status: superseded|historical` + repo-root `superseded_by`) — do not overload `authority`/`doc_authority` (the retrieval ranking ladder) or plan `status` (progress); overloading an existing key is the same confusion being fixed. (2) Canonical-ness lives in exactly one place per category (documentation-source-map + concept-registry), never in a doc claiming itself canonical. (3) Retiring a doc edits it, so its `last_updated` moves forward; recency scoring then outweighs any authority demotion (recency up to 10 vs authority step ~1) and the stale doc outranks current ones. Retired docs must earn no recency credit; test ranking against a current doc, not just the field value. (4) Make meaning checkable: one definition per registered term, glossary rows equal the registry, aliases may not have their own heading, new architecture docs declare `concepts:` under a shrink-only baseline, every monthly plan index links all plans. See knowledge/product/governance/concept-registry-workflow.md.

## Recommended References

- active/missions/public/MSN-CONCEPT-REGISTRY-20261109/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-CONCEPT-REGISTRY-20261109/evidence/test-report.md

## Evidence

- active/missions/public/MSN-CONCEPT-REGISTRY-20261109/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-CONCEPT-REGISTRY-20261109/evidence/test-report.md

## Artifacts

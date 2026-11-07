---
record_id: mem-MSN-CORE-PLACEMENT-20261107-2026_11_07
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CORE-PLACEMENT-20261107-2026_11_07
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-07T16:50:07.528Z
source_branch: refactor/core-placement-20261107
source_commit: 1d042d119ad3a1bfda01f6da0371998c022690f2
---

# Core placement preserves public exports and validates physical paths

Classify core modules by responsibility while treating export compatibility, physical runtime paths and compiled graph freshness as separate checks.

## Hint Scope

mission

## Trigger Phrases

- Read imports, consumers and initialization before moving a core module. Keep public export keys stable while remapping targets, move associated tests and native helpers, and register domain ownership plus justified root boundaries in core_placement. Audit embedded child imports, query-suffixed reevaluation and source/dist path construction separately. Clean-build before dependency or foundation-weight gates so obsolete emitted modules cannot distort the graph. Preserve cycle and weight budgets. Freeze source for final failed-and-affected regression reruns; a repair-time full-suite discovery run alone is not a final green claim.

## Recommended References

- active/missions/public/MSN-CORE-PLACEMENT-20261107/evidence/complete-core-placement.md

## Evidence

- active/missions/public/MSN-CORE-PLACEMENT-20261107/evidence/complete-core-placement.md

## Artifacts

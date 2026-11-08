---
record_id: mem-MSN-TIER-PATH-MODEL-20261108-2026_11_08
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-TIER-PATH-MODEL-20261108-2026_11_08
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-08T09:50:35.409Z
source_branch: fix/formal-safety-boundaries-20261108
source_commit: f15e02028d023dcef1b12598f81fef07b0d94972
---

# Keep resource tier classification invariant under checkout relocation

Outer scratch or knowledge partitions describe checkout placement, not the data tier of inner repository resources.

## Hint Scope

mission

## Trigger Phrases

- Before interpreting tier markers, use the canonical policy-relative path mapping for current-checkout and shared primary-authority resources. Preserve normalized absolute fallback for genuinely outside-root paths; do not repair ancestor shadowing by reordering substring tests. Declare expected inner partitions independently of the production parser, enumerate relocation across tiered scratch/artifact/runtime/knowledge ancestors, compare production results, and require an ancestor-first negative control. Build before compiled-module integration tests. The finite path model complements tenant, resource and symlink guards; it does not replace them.

## Recommended References

- active/missions/public/MSN-TIER-PATH-MODEL-20261108/evidence/implementation-report.md
- active/missions/public/MSN-TIER-PATH-MODEL-20261108/evidence/test-report.md
- active/missions/public/MSN-TIER-PATH-MODEL-20261108/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-TIER-PATH-MODEL-20261108/evidence/implementation-report.md
- active/missions/public/MSN-TIER-PATH-MODEL-20261108/evidence/test-report.md
- active/missions/public/MSN-TIER-PATH-MODEL-20261108/evidence/REVIEW-execution-implement.md

## Artifacts

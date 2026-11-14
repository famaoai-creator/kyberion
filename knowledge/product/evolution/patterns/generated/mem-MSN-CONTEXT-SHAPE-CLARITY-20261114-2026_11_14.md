---
record_id: mem-MSN-CONTEXT-SHAPE-CLARITY-20261114-2026_11_14
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CONTEXT-SHAPE-CLARITY-20261114-2026_11_14
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-14T13:35:38.548Z
source_branch: fix/context-shape-clarity-20261114
source_commit: 1fd0ca3d121ae989e3fe47f2907089e7f28dc76f
---

# Preserve unknown provenance when restoring legacy context

A value restored by normalization or a migration does not establish what the original caller supplied; lossy execution projections cannot reconstruct execution choices.

## Applicability

- mission
- mission:MSN-CONTEXT-SHAPE-CLARITY-20261114

## Reusable Steps

1. A value restored by normalization or a migration does not establish what the original caller supplied; lossy execution projections cannot reconstruct execution choices

## Expected Outcome

When adding context provenance, store it with new records and preserve known origins on unchanged updates. Legacy migrations must copy only known provenance and leave restored defaults unknown. Test a real old-format ledger record, not only records produced by the new facade. Keep descriptive provenance separate from authorization and entity-existence checks. For intent display, prefer canonical execution_shape; a legacy many-to-one task_session projection cannot prove a Task Session record exists. Validate creation, updates, migration, idempotent replay and displayed labels together.

## Evidence

- active/missions/public/MSN-CONTEXT-SHAPE-CLARITY-20261114/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-CONTEXT-SHAPE-CLARITY-20261114/evidence/test-report.md

## Artifacts

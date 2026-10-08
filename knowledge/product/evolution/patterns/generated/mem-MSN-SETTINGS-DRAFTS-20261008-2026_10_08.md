---
record_id: mem-MSN-SETTINGS-DRAFTS-20261008-2026_10_08
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-SETTINGS-DRAFTS-20261008-2026_10_08
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-08T10:47:32.061Z
source_branch: fix/surface-outcome-clarity-20261008
source_commit: aad6c1787fa5f7ccfa476f992c779e8a9d0af3b0
---

# Keep editable settings drafts separate from acknowledged saves

Independent settings reads and saves need per-group draft ownership, immutable submitted snapshots, and explicit uncertain outcomes.

## Applicability

- mission
- mission:MSN-SETTINGS-DRAFTS-20261008

## Reusable Steps

1. Independent settings reads and saves need per-group draft ownership, immutable submitted snapshots, and explicit uncertain outcomes

## Expected Outcome

## When to apply

Use this pattern when one settings page combines independently loaded and saved sections. A successful save in one section must not erase another section’s unsubmitted work.

## Pattern

1. Keep each editable draft separate from its last acknowledged server baseline. Capture the submitted snapshot before asynchronous work. A valid receipt acknowledges that snapshot, never the newer live draft.
2. Reconcile refreshes against the current dirty state. Fence stale reads per mutation group; a Profile save must not orphan an unrelated pending Notifications read. Track edits made before initial hydration, include them in Save All, and define early-discard behavior.
3. Validate operation-specific success receipts rather than HTTP status alone. Advance successful sections independently, retain failed sections, and distinguish unconfirmed submissions from preflight failures. Never automatically replay an uncertain mutation.
4. Scope draft ownership to the existing server-resolved account and settings context. Clear drafts and cancel queued client work on observed context change, authentication loss or restored stale page state. Separate identity checks are not an atomic server-side binding and must not be described as one.
5. Verify delayed reads and bodies, edits back to an earlier value, same-turn repeat clicks, partial batches, malformed receipts, initial-load interleavings, context changes and unmounts in mounted tests. Preserve aggregate test failures separately from narrower corrected reruns.

## Boundary

This pattern governs client draft lifecycle. It does not change service-disconnection semantics, server authorization, backend idempotency or the result of an already-running server operation.

## Evidence

- active/missions/public/MSN-SETTINGS-DRAFTS-20261008/evidence/implementation-report.md
- active/missions/public/MSN-SETTINGS-DRAFTS-20261008/evidence/test-report.md
- active/missions/public/MSN-SETTINGS-DRAFTS-20261008/evidence/independent-review.md
- active/missions/public/MSN-SETTINGS-DRAFTS-20261008/evidence/distillation.md

## Artifacts

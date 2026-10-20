---
record_id: mem-MSN-SCOPED-WORKSPACES-20261021-2026_10_20
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-SCOPED-WORKSPACES-20261021-2026_10_20
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-20T20:11:34.382Z
source_branch: feat/scoped-workspaces-20261021
source_commit: 1381f6e4966dfb8a062d2bb71eeab4a145eeb1e7
---

# Scoped workplace projections require verified provenance and frozen responsibility bindings

Keep owner hierarchy, viewer authorization and operation responsibility separate; never infer sensitivity or transfer old approvals when bindings change.

## Applicability

- mission
- mission:MSN-SCOPED-WORKSPACES-20261021

## Reusable Steps

1. Keep owner hierarchy, viewer authorization and operation responsibility separate; never infer sensitivity or transfer old approvals when bindings change

## Expected Outcome

Apply when adding a UI projection across tenant, organization, Project and Operation. Resolve real registry parents and narrow the authenticated viewer; URL selections never grant authority. A WorkItem without a sensitivity tier requires an authoritative owner or a durable admission that matches the current source responsibility binding; otherwise withhold it. Freeze operation responsibility in admission identity, approval provenance and work metadata. A changed or removed binding must preserve old parked decisions without reinterpreting them as new work. Use locked optimistic owner/status/binding checks for autonomous controls. Display unavailable counts as unknown and distinguish future wakeup suspension from cancellation. Verify with real registry and artifact storage, sibling and mixed-tier fixtures, stale decision regression tests and mounted UI recovery tests.

## Evidence

- active/missions/public/MSN-SCOPED-WORKSPACES-20261021/evidence/implementation-report.md
- active/missions/public/MSN-SCOPED-WORKSPACES-20261021/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-SCOPED-WORKSPACES-20261021/evidence/test-report.md

## Artifacts

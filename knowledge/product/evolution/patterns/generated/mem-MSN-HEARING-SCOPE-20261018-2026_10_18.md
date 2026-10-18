---
record_id: mem-MSN-HEARING-SCOPE-20261018-2026_10_18
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-HEARING-SCOPE-20261018-2026_10_18
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-18T09:28:53.694Z
source_branch: fix/hearing-selected-scope-20261018
source_commit: 33988d7f184d40e77760a82a5f8281b100cbd1d2
---

# Selected request scope must survive every handoff boundary

Narrow every related endpoint with the authenticated selection, carry it into independent resources, and prove destination hierarchy before reserving a handoff.

## Applicability

- mission
- mission:MSN-HEARING-SCOPE-20261018

## Reusable Steps

1. Narrow every related endpoint with the authenticated selection, carry it into independent resources, and prove destination hierarchy before reserving a handoff

## Expected Outcome

Cue: a tenant/session draft is shared while the UI selects an organization or project. Reuse the authenticated scope-narrowing facade before every related read and write; carry only the validated selection into separately loaded resources and bind decision receipts/snapshots to it. Before reservation, verify exact tenant/organization/project ownership and supported controller prerequisites. If the destination cannot represent a selected dimension, reject it with actionable pre-write copy while preserving input and selection; never broaden or switch scope silently. Treat historical completion as read-only destination proof: original links may remain available in an explicitly authorized broader view, without rewriting metadata or resending effects. Evidence: three real-route regression assertions failed on unchanged main (selection did not affect snapshot identity, a foreign selector returned 200, canvas scope disappeared) and passed after the fix; expanded tests cover seven endpoint boundaries, hierarchy checks, stale and unknown/no-resend recovery, and legacy completion. Limits: synthetic authorization/member fixtures and mocked mission subprocesses; VM client checks are not rendered E2E. Normal Chromium launch was blocked by socket EPERM before attachment.

## Evidence

- active/missions/public/MSN-HEARING-SCOPE-20261018/evidence/implementation-report.md
- active/missions/public/MSN-HEARING-SCOPE-20261018/evidence/test-report.md
- active/missions/public/MSN-HEARING-SCOPE-20261018/evidence/REVIEW-execution-implement.md

## Artifacts

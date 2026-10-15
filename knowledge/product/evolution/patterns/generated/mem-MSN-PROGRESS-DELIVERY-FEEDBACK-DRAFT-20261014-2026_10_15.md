---
record_id: mem-MSN-PROGRESS-DELIVERY-FEEDBACK-DRAFT-20261014-2026_10_15
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-PROGRESS-DELIVERY-FEEDBACK-DRAFT-20261014-2026_10_15
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-15T06:00:10.224Z
source_branch: fix/progress-delivery-feedback-draft-20261014
source_commit: 818ed3ff8dcd300da0ce54cbc64db4df85c3918e
---

# Keep delivery feedback drafts aligned with mutation identity

Share one viewer-scoped correction draft across visible artifacts belonging to the same feedback entry while preserving exact artifact context and live eligibility fences.

## Applicability

- mission
- mission:MSN-PROGRESS-DELIVERY-FEEDBACK-DRAFT-20261014

## Reusable Steps

1. Share one viewer-scoped correction draft across visible artifacts belonging to the same feedback entry while preserving exact artifact context and live eligibility fences

## Expected Outcome

When multiple visible artifacts share one server-side feedback entry, key correction draft and pending state by viewer scope plus entry. Transfer one editor without replacing its draft object, focus only after attachment, and invalidate detached callbacks with render generation and current eligibility. Explain delivery-wide actions and require explicit discard before conflicting acceptance. Preserve each artifact's exact correction-context identifiers; shared editor state must not broaden backend visibility or authorization.

Test real sibling fixtures, independent entries, stale callbacks, revoked eligibility, missing helper/load order, exact submitted text and uncertain outcomes. Bind browser QA to final built bytes. Compare residual behavior with baseline; a preexisting terminal-History retained-draft limitation should be disclosed rather than silently expanded into unrelated scope.

## Evidence

- active/missions/public/MSN-PROGRESS-DELIVERY-FEEDBACK-DRAFT-20261014/evidence/test-report.md
- active/missions/public/MSN-PROGRESS-DELIVERY-FEEDBACK-DRAFT-20261014/evidence/browser-qa.json

## Artifacts

---
record_id: mem-MSN-PROGRESS-CORRECTION-RECOVERY-20261015-2026_10_16
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-PROGRESS-CORRECTION-RECOVERY-20261015-2026_10_16
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-16T03:26:57.763Z
source_branch: fix/progress-correction-recovery-20261015
source_commit: f06ea635dc71cabfc5b591c430027e06a368a01a
---

# Keep unconfirmed correction text separate from recorded outcomes

A terminal server verdict does not prove that a locally retained correction note was saved; preserve a scope-bound copy without replaying the mutation.

## Applicability

- mission
- mission:MSN-PROGRESS-CORRECTION-RECOVERY-20261015

## Reusable Steps

1. A terminal server verdict does not prove that a locally retained correction note was saved; preserve a scope-bound copy without replaying the mutation

## Expected Outcome

After a correction POST response is lost, preserve the exact local draft while reconciling the authoritative server outcome. A later accepted, rejected, or changes-requested status does not establish that the recorded note matches local text. Display retained text as an enabled read-only field in authorized History, labeled save-unconfirmed, with copy and explicit discard support. Do not automatically retry the POST or replace correction-request navigation with unverified local text.

Bind recovery to verified viewer scope and delivery-entry identity. Keep one visible owner among sibling artifacts and fence stale render callbacks, scope changes, pending writes, and reads started before the failed write. A newer authorized read may clear uncertainty; status alone must not claim text equality. Leave warnings describe loss of the local copy without claiming the server did or did not save it. Regression coverage includes competing tab outcomes, matching or empty server feedback, sibling changes, keyboard selection, repeated navigation, explicit discard, and interrupted responses. Synthetic browser fixtures validate UI behavior but do not establish live provider end-to-end delivery.

## Evidence

- active/missions/public/MSN-PROGRESS-CORRECTION-RECOVERY-20261015/evidence/test-report.md
- active/missions/public/MSN-PROGRESS-CORRECTION-RECOVERY-20261015/evidence/browser-qa.json

## Artifacts

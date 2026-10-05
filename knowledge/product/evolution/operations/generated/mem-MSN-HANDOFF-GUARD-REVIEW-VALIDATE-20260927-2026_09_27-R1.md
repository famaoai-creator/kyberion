---
record_id: mem-MSN-HANDOFF-GUARD-REVIEW-VALIDATE-20260927-2026_09_27-R1
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-HANDOFF-GUARD-REVIEW-VALIDATE-20260927-2026_09_27-R1
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T13:32:26.656Z
source_branch: fix/voice-media-session-id-20261005
source_commit: 3914948b3e61c1a44cc2ec7e79234920b20756a7
---

# Content-bound hand-off claims; schema-validate review receipts before writing

Marker-based collection of host outputs and why review-task findings must match the receipt schema.

## Procedure Steps

1. Host/agent hand-off collection: place one marker per pending target (sharedTmp('host-image-handoff/<sha256(target)[:16]>.json') = {provider_id, target, prompt, requested_at_ms}). Claim the output only when the file exists AND marker.target+prompt match AND the file's content hash differs from the hash recorded at request time; a claimed marker is consumed, a re-request with the same prompt refreshes the marker, and an existing non-matching file triggers a fresh request rather than a false collect. Review receipts: build then assert the artifact-review-receipt schema before writing — a finding written with severity 'major' (instead of blocking|suggestion) produced a verdict of 'approved' but an unloadable receipt, so the review task was never satisfied with no visible error. Receipt validation errors must name the schema errors and the expected finding shape.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-HANDOFF-GUARD-REVIEW-VALIDATE-20260927/evidence/design-spec.json
- active/missions/public/MSN-HANDOFF-GUARD-REVIEW-VALIDATE-20260927/evidence/implementation-report.md
- active/missions/public/MSN-HANDOFF-GUARD-REVIEW-VALIDATE-20260927/evidence/distillation.md

## Artifacts

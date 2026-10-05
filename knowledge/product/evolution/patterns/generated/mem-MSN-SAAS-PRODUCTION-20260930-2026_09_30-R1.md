---
record_id: mem-MSN-SAAS-PRODUCTION-20260930-2026_09_30-R1
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-SAAS-PRODUCTION-20260930-2026_09_30-R1
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T13:31:16.531Z
source_branch: fix/voice-media-session-id-20261005
source_commit: 3914948b3e61c1a44cc2ec7e79234920b20756a7
---

# Non-required CI workflow failure on unsupported model is not a merge blocker

Distinguish required-check status from auxiliary workflow health when judging PR readiness.

## Applicability

- mission
- mission:MSN-SAAS-PRODUCTION-20260930

## Reusable Steps

1. Distinguish required-check status from auxiliary workflow health when judging PR readiness

## Expected Outcome

Risk rule for PR verification: the separate 'Code scanning / AI findings' GitHub workflow fails before producing any review when its hosted model request returns HTTP 400 'The requested model is not supported' (CAPIError). This was observed on both PR #826 (run 36513115486) and PR #836. It is not a required PR check and produced no source finding, so it must not block merge or mission verification — required-check green on the final head is the criterion. Operationally: when triaging a red check, first ask whether the check is required; an auxiliary AI-review failure usually means the workflow pins an unsupported/retired model and needs a model-name fix in the workflow file, tracked as its own chore rather than treated as a code regression. Record the distinction explicitly in the delivery report so reviewers do not re-litigate it.

## Evidence

- active/missions/public/MSN-SAAS-PRODUCTION-20260930/evidence/distillation.md
- active/missions/public/MSN-SAAS-PRODUCTION-20260930/evidence/delivery-report.md

## Artifacts

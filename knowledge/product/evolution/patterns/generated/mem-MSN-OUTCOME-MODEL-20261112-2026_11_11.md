---
record_id: mem-MSN-OUTCOME-MODEL-20261112-2026_11_11
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-OUTCOME-MODEL-20261112-2026_11_11
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-11-11T22:41:34.233Z
source_branch: feat/outcome-model-20261112
source_commit: 0192345fa23aaf66755df6bc564a30a4dc7e1041
---

# Keep outcome verification and delivery as independent result facts

Result projections must preserve unassessed criteria, explicit failures and unknown delivery coverage instead of upgrading output references or worker reports into verified completion.

## Applicability

- mission
- mission:MSN-OUTCOME-MODEL-20261112

## Reusable Steps

1. Result projections must preserve unassessed criteria, explicit failures and unknown delivery coverage instead of upgrading output references or worker reports into verified completion

## Expected Outcome

When projecting an OutcomeContract, worker result and authorized artifact records, keep intended success criteria, concrete output references, criterion-bound evidence, current delivery bindings and remaining work separate. Match criterion identities exactly; require nonblank support for a passing report, but retain an explicit failed report even when its evidence text is blank. Preserve unknown delivery coverage for every output, including outputs lacking ArtifactRecord delivery bindings; a successful receipt for one output must not make the whole result delivered. Worker-reported pass is not independent verification, and transport delivery is not human readership or acceptance. Rebuild derived completion snapshots from current source facts on save and invalidate them when work is reopened. Test duplicate pass/fail reports, mixed delivered/untracked outputs and reopen/revision flows. Reuse existing review and delivery records rather than creating another result ledger.

## Evidence

- active/missions/public/MSN-OUTCOME-MODEL-20261112/evidence/REVIEW-execution-reshape.md
- active/missions/public/MSN-OUTCOME-MODEL-20261112/evidence/equivalence-report.md

## Artifacts

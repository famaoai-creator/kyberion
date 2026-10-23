---
record_id: mem-MSN-DECISION-DELEGATION-20261023-2026_10_23
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-DECISION-DELEGATION-20261023-2026_10_23
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-23T23:52:38.667Z
source_branch: feat/decision-delegation-20261023
source_commit: f7b8bdf0dd0e9b50c31f29afa04d0c656a0720e1
---

# delegated_decisions rides the same request plane as external-operation grants

Charter delegated_decisions (policy per business decision type) extends the authority request input, plan builder, read model and Concierge panel — validated against charter-decision-vocabulary delegable types; revoke deletes entries.

## Applicability

- mission
- mission:MSN-DECISION-DELEGATION-20261023

## Reusable Steps

1. Charter delegated_decisions (policy per business decision type) extends the authority request input, plan builder, read model and Concierge panel — validated against charter-decision-vocabulary delegable types; revoke deletes entries

## Expected Outcome

Pattern: a charter envelope field becomes user-editable by adding it to OnboardingAuthorityInput parse + buildPlan merge + readOnboardingAuthority output + one panel block. The vocabulary catalog (label.ja/en) supplies localized row labels so no vocab keys are needed per decision type.

## Evidence

- active/missions/public/MSN-DECISION-DELEGATION-20261023/evidence/implementation-report.md
- active/missions/public/MSN-DECISION-DELEGATION-20261023/evidence/distillation.md

## Artifacts

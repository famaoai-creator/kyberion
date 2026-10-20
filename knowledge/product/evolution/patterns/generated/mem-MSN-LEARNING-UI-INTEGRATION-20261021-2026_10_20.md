---
record_id: mem-MSN-LEARNING-UI-INTEGRATION-20261021-2026_10_20
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-LEARNING-UI-INTEGRATION-20261021-2026_10_20
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-20T18:34:20.843Z
source_branch: feat/external-actuator-governance-20261021
source_commit: 22883cb6a371050f881968c8f5a472ee7aa9717c
---

# Separate candidate disposition from learning publication authority

Keep exact scoped identity and atomic state checks through every learning decision while preserving the canonical approval and publication boundary.

## Applicability

- mission
- mission:MSN-LEARNING-UI-INTEGRATION-20261021

## Reusable Steps

1. Keep exact scoped identity and atomic state checks through every learning decision while preserving the canonical approval and publication boundary

## Expected Outcome

A candidate that cannot be published may still be safely rejected by an authorized operator. Keep rejection separate from positive approval and publication operations; do not restore legacy shortcuts or remove scope restrictions to make a UI actionable. Carry candidate id and exact scope through selection, review, mutation and result verification. Reuse the canonical readiness gate for approval and compare observed status while holding the queue mutation mutex. UI refresh must distinguish implicit selection from explicit deep links, and delayed responses must not overwrite a newer tenant or requested candidate. Validate sibling-scope isolation, public product approval and unsupported-candidate rejection with real queue tests.

## Evidence

- active/missions/public/MSN-LEARNING-UI-INTEGRATION-20261021/evidence/implementation-report.md
- active/missions/public/MSN-LEARNING-UI-INTEGRATION-20261021/evidence/test-report.md
- active/missions/public/MSN-LEARNING-UI-INTEGRATION-20261021/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-LEARNING-UI-INTEGRATION-20261021/evidence/REVIEW-contract_authoring-ux-contract.md

## Artifacts

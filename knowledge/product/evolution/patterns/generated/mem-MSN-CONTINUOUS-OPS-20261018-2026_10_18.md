---
record_id: mem-MSN-CONTINUOUS-OPS-20261018-2026_10_18
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CONTINUOUS-OPS-20261018-2026_10_18
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-18T06:45:16.487Z
source_branch: feat/continuous-operations-20261018
source_commit: c5f3fd5c5634789fa6f65998da8c774e17bd65e9
---

# Treat continuous observations as evidence rather than execution authority

A periodic collector may propose work through reviewed scoped rules, while durable episode identity and native admission preserve authorization and deduplication.

## Applicability

- mission
- mission:MSN-CONTINUOUS-OPS-20261018

## Reusable Steps

1. A periodic collector may propose work through reviewed scoped rules, while durable episode identity and native admission preserve authorization and deduplication

## Expected Outcome

Collect only bounded numeric observations with original timestamps and evidence references. Validate all sources and exact tier, tenant, organization and project before updating state or admitting work. Keep source acquisition separate from deterministic policy. Persist episode identity before admission, reconcile uncertain admission with the same identity, and require explicit recovery for definitive refusal. Preserve previous work references after metric recovery so feedback remains visible. Capacity exhaustion defers new admission without spending episode identity. A metric improvement is an observation, not proof of a causal effect.

## Evidence

- active/missions/public/MSN-CONTINUOUS-OPS-20261018/evidence/test-report.md

## Artifacts

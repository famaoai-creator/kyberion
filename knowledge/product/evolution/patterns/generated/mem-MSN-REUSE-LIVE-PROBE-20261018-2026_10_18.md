---
record_id: mem-MSN-REUSE-LIVE-PROBE-20261018-2026_10_18
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-REUSE-LIVE-PROBE-20261018-2026_10_18
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-18T10:56:55.030Z
source_branch: fix/workflow-reuse-live-policy-20261018
source_commit: 5b84761162da00ee98c46b80f70243ba1b257c26
---

# Verify workflow reuse with real provider and approved replay

Completion success alone does not prove workflow assessment or execution; test provider wire compatibility, scoped handoff and approved input variants.

## Applicability

- mission
- mission:MSN-REUSE-LIVE-PROBE-20261018

## Reusable Steps

1. Completion success alone does not prove workflow assessment or execution; test provider wire compatibility, scoped handoff and approved input variants

## Expected Outcome

The live workflow reuse probe found two blockers hidden by mocked model tests: no governed LLM profiles were passed, and arbitrary ADF dictionary output was rejected by the provider strict schema. Pass the schema-validated wisdom policy into the adaptive runner. Transport ADF as JSON text, parse it safely and retain internal schema, ADF, guardrail and dry-run validation. Confirm candidate identity is stable for unchanged evidence. Treat generation and static validation separately from execution: human project-trust approval was required, then A/B/A and an additional output-visible B run succeeded with four ok traces. The synthetic logging candidate is evidence, not a product template. This record is curated from live evidence; mission distillation used structural fallback after an unrelated optional experience field returned null.

## Evidence

- active/missions/public/MSN-REUSE-LIVE-PROBE-20261018/evidence/live-loop-probe.json
- active/missions/public/MSN-REUSE-LIVE-PROBE-20261018/evidence/retrospective.md
- active/missions/public/MSN-REUSE-LIVE-PROBE-20261018/evidence/REVIEW-execution-implement.md

## Artifacts

---
record_id: mem-MSN-PROMPT-ONBOARDING-20261018-2026_10_17
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-PROMPT-ONBOARDING-20261018-2026_10_17
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-17T17:51:32.187Z
source_branch: feat/prompt-first-onboarding-20261018
source_commit: f20526693b7380df9acde326b1b7a27f351bd961
---

# Bootstrap prompt-first onboarding before invoking an unbuilt runtime

Separate source-only bootstrap, identity, confidentiality scope, and first-work readiness.

## Applicability

- mission
- mission:MSN-PROMPT-ONBOARDING-20261018

## Reusable Steps

1. Separate source-only bootstrap, identity, confidentiality scope, and first-work readiness

## Expected Outcome

Make LLM CLI setup instructions readable before dependencies and dist exist. Bootstrap in canonical first-win order without bypassing runnable failure or circuit-breaker behavior. Gather actual identity in conversation, then dry-run and apply the same JSON. Personal use needs no tenant; company setup explicitly binds its tenant. Separate service connections from organization services. Reuse saved receipts when resuming and retain human activation and provider-egress approval. Validate facade behavior separately from fresh-clone end-to-end claims.

## Evidence

- active/missions/public/MSN-PROMPT-ONBOARDING-20261018/evidence/implementation-report.md
- active/missions/public/MSN-PROMPT-ONBOARDING-20261018/evidence/test-report.md

## Artifacts

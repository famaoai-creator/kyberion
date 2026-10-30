---
record_id: mem-MSN-REASONING-ATTACHMENT-20261029-2026_10_28
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-REASONING-ATTACHMENT-20261029-2026_10_28
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-28T19:41:03.880Z
source_branch: fix/reasoning-attachment-scope-20261029
source_commit: e11b70d63df473e56191bbf881346531f804a305
---

# Declare inference attachment facts at trusted payload boundaries

Explicit processor scopes reject unknown attachment counts; concrete text and image senders must supply facts without weakening inherited task policy.

## Applicability

- mission
- mission:MSN-REASONING-ATTACHMENT-20261029

## Reusable Steps

1. Explicit processor scopes reject unknown attachment counts; concrete text and image senders must supply facts without weakening inherited task policy

## Expected Outcome

When extending reasoning egress scopes, construct attachment_count at the concrete trusted payload boundary: zero for a text-only prompt, the outgoing image count for vision. An omitted count is unknown and must fail closed for an explicitly processor-scoped charter. Generic task, dot and pipeline envelopes cannot assume zero before their payload is known. Preserve inherited backend allowlists, external-egress restrictions, tenant context and provider endpoint checks while adding facts. Verify missing, negative and fractional counts, real image counts and text-only callers; run leak checks separately from builds to avoid counting concurrent compiler output as test pollution.

## Evidence

- active/missions/public/MSN-REASONING-ATTACHMENT-20261029/evidence/implementation-report.md
- active/missions/public/MSN-REASONING-ATTACHMENT-20261029/evidence/test-report.md

## Artifacts

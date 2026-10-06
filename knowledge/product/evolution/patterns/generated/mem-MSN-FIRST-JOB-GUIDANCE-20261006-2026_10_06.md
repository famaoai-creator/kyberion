---
record_id: mem-MSN-FIRST-JOB-GUIDANCE-20261006-2026_10_06
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-FIRST-JOB-GUIDANCE-20261006-2026_10_06
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-06T20:44:12.909Z
source_branch: feat/first-job-setup-guidance-20261006
source_commit: 76fa163bb3af725d67d5d5b0ee9de81b4f1e61c2
---

# First-job setup guidance must distinguish observations from authorization

Project setup as bounded, read-only evidence; revalidate the current actor and exact scope, and invalidate stale guidance across asynchronous browser lifecycle changes.

## Applicability

- mission
- mission:MSN-FIRST-JOB-GUIDANCE-20261006

## Reusable Steps

1. Project setup as bounded, read-only evidence; revalidate the current actor and exact scope, and invalidate stale guidance across asynchronous browser lifecycle changes

## Expected Outcome

## Applicability

Use this pattern for setup dashboards that combine local configuration, a browser identity, tenant-bound approvals, and asynchronously advancing work.

## Practices

1. Report each observation independently using fixed status, responsible-party, and next-action codes. Distinguish missing, unavailable, unchecked, and not-required states. A profile file's presence is not proof of identity, and local OIDC configuration is not proof of provider connectivity.
2. Keep the projection within the existing authorized read boundary. Read only necessary local evidence, return no registry or credential details, and never provision membership, perform maintenance, or probe providers to answer a setup read. Explicit sign-in may contact the configured identity provider; normal request authentication auditing remains.
3. Verify the browser session and its active identity binding at the latest successful read. Compare its owner to the exact mapped diagnostic owner and current tenant role; a generic logged-in flag cannot authorize work. Keep mutation authorization authoritative and independent of advisory readiness.
4. Invalidate affected identity, scope, and progress evidence before uncertain mutations and after errors, authentication loss, refresh, or suspension. Known redacted configuration blockers may remain, but positive evidence must not survive contrary observations. Ignore superseded asynchronous reads. Preserve an in-flight mutation callback during suspension, then refresh when visible, so cancellation cannot strand a busy state; do not treat late mutation responses as fresh authorization.
5. Separate terminal history from active work. A terminated unstarted request should not hide a replacement request's progress. Hide tick guidance during in-flight mutations, unresolved recovery blockers, or uncertain status. Awaiting-approval work can still require a bounded tick to expose an approval.
6. Test both clients together with deterministic fixtures for missing configuration, permission failures, owner mismatch, revoked identity, interrupted reads, hidden-page mutation settlement, and replacement after terminal recovery. Treat these as fixture evidence; report real browser and OIDC acceptance separately.

## Outcome

The interface can explain what is known, who should act next, and which prerequisite remains unresolved without turning readiness into an authorization grant or presenting stale observations as current truth.

## Evidence

- active/missions/public/MSN-FIRST-JOB-GUIDANCE-20261006/evidence/implementation-report.md
- active/missions/public/MSN-FIRST-JOB-GUIDANCE-20261006/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-FIRST-JOB-GUIDANCE-20261006/evidence/REVIEW-contract_authoring-ux-contract.md
- active/missions/public/MSN-FIRST-JOB-GUIDANCE-20261006/evidence/test-report.md

## Artifacts

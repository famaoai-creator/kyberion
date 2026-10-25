---
record_id: mem-MSN-CUSTOMER-DECISION-CD12-VIEWS-20261026-2026_10_25
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CUSTOMER-DECISION-CD12-VIEWS-20261026-2026_10_25
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-25T20:13:33.248Z
source_branch: feat/customer-decision-cd12-views-20261026
source_commit: 29e0ead6cabfd80dfcf34817adac8c7ace0aa927
---

# Read-only drill-down views over tenant-confidential stores through a scoped facade child

Show operators case, agenda-set and learning detail in Chronos without exposing confidential values: field-by-field core builders, allowlist parsers on the server, one viewer-scope helper before cache and child, a bounded child queue with a negative cache, and shell-safe command hints.

## Procedure Steps

1. ## Context

CD-12 drill-down: Chronos reads customer-decision detail by running the customer-decision facade as a tenant-bound child process.

## Lessons

1. Build views by copying fields one by one (never spread store records) and rebuild again in an import-free allowlist parser on the server, so a misbehaving child cannot pass an extra field such as a value.
2. Put the whole viewer-scope sequence (project refusal, tenant narrowing, registry, tier, organization) in one helper that every route calls before input validation, cache lookup and child spawn; key caches by kind:tenant:arg.
3. A child process per request needs a bounded wait queue (503 when full) and a short negative cache for not-found answers; evict settled entries before in-flight ones.
4. Validate route inputs completely (real calendar dates, id patterns) before spawning, and set Cache-Control: no-store on every response, errors included.
5. Keep drill-down selection in the URL, clear it on every path that changes tenant or organization, and move focus only after in-app navigation (preventScroll).
6. Command hints shown for copy/paste must be shell-safe — print one line per alternative instead of `a|b`.

## How to apply

Reuse resolveCustomerDecisionTenant and readCustomerDecisionFacade for any new customer-decision Chronos view; add the route to SCOPE_ROUTES and keep the `resolvedViewer` naming the route contract test expects.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-CUSTOMER-DECISION-CD12-VIEWS-20261026/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-CUSTOMER-DECISION-CD12-VIEWS-20261026/evidence/implementation-report.md
- active/missions/public/MSN-CUSTOMER-DECISION-CD12-VIEWS-20261026/evidence/retrospective.md
- active/missions/public/MSN-CUSTOMER-DECISION-CD12-VIEWS-20261026/evidence/design-spec.json
- active/missions/public/MSN-CUSTOMER-DECISION-CD12-VIEWS-20261026/evidence/test-report.md

## Artifacts

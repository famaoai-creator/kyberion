---
record_id: mem-MSN-CUSTOMER-DECISION-CD12-20261025-2026_10_24
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CUSTOMER-DECISION-CD12-20261025-2026_10_24
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-24T21:34:28.643Z
source_branch: feat/customer-decision-cd12-20261025
source_commit: d9a5590e8114a8d9a4c2d6f0a5f91045b3ba9abe
---

# Viewer-facing reads through a privileged child: re-apply every viewer check in the route

Lessons from the CD-12 Chronos overview: a tenant-bound facade child keeps Chronos from gaining data authority, but it bypasses the viewer tier and organization limits, so the route must enforce them before any cache; list parsers should truncate; learning dedupe compares against queue-time evidence.

## Applicability

- mission
- mission:MSN-CUSTOMER-DECISION-CD12-20261025

## Reusable Steps

1. Lessons from the CD-12 Chronos overview: a tenant-bound facade child keeps Chronos from gaining data authority, but it bypasses the viewer tier and organization limits, so the route must enforce them before any cache; list parsers should truncate; learning dedupe compares against queue-time evidence

## Expected Outcome

Applies when a surface route serves tenant data produced by a governed child process or service.

1. Running the governed facade as a tenant-bound child with no system role keeps the surface from gaining data authority (no reachability change).
2. The child runs under its own roles, so the viewer tier and organization limits never apply there: the route must call strictViewerTier and strictViewerScopeOrganizationIds (after tenant narrowing and the registry check) before any cache lookup; a per-tenant cache is then safe.
3. Return a summary shape from the child for dashboards (drop per-entry detail, cap lists with total counts) and make parsers truncate oversized lists rather than reject them, or large tenants turn into permanent errors.
4. Guard client fetches against stale responses after a scope switch.
5. For periodic learning suggestions, dedupe by suggestion key across dates and statuses and compare new evidence with the evidence at queue time, not last week.

## Evidence

- active/missions/public/MSN-CUSTOMER-DECISION-CD12-20261025/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-CUSTOMER-DECISION-CD12-20261025/evidence/retrospective.md
- active/missions/public/MSN-CUSTOMER-DECISION-CD12-20261025/evidence/implementation-report.md

## Artifacts

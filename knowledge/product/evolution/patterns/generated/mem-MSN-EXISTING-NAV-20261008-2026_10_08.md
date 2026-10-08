---
record_id: mem-MSN-EXISTING-NAV-20261008-2026_10_08
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-EXISTING-NAV-20261008-2026_10_08
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-08T17:06:25.665Z
source_branch: feat/existing-surface-navigation-20261008
source_commit: 47a407dad024b1315a049884bac78fe82fa340e7
---

# Discoverable navigation preserves destination scope and authorization

Expand navigation from one existing-route catalog, verify the exact optional destination, and preserve each surface's scope contract without treating menu visibility as permission.

## Applicability

- mission
- mission:MSN-EXISTING-NAV-20261008

## Reusable Steps

1. Expand navigation from one existing-route catalog, verify the exact optional destination, and preserve each surface's scope contract without treating menu visibility as permission

## Expected Outcome

## Applicability

Use when several user-facing surfaces share navigation and command search.

## Practices

1. Inventory real routes and subnavigation before removing arbitrary item-count restrictions. Do not invent screens, duplicate aliases or expose internal API endpoints.
2. Feed every renderer and command search from one server-resolved catalog of labels, groups, icons and role minima. Unknown permissions fail closed; destination authentication, membership, tenant and mutation guards remain authoritative.
3. Check the exact optional destination with a bounded same-origin request, without redirects or starting services. A registered URL or an IPv4 probe is not evidence that a different IPv6 or remote browser URL works.
4. Preserve tenant, organization and project using the destination's actual query names. Omit a shortcut to a process-bound tenant view until it supports explicit scope preservation; health and visibility do not establish authorization or scope parity.
5. Test both renderers and search for active routes, keyboard dismissal/reopen/focus, stale tenant/locale responses, Back/Forward, settings hashes and scrollable long menus. Clear older scope aliases on tenant changes.

## Evidence and limits

Independent review caught scope-name drift, a mismatched IPv6 health target and an unscoped monitor before publication. Regression tests and builds support the fixes. DOM/CSS tests are not visual mobile or real sign-in acceptance. Offline structural distillation and explicitly stubbed promotion provide no external-provider semantic verdict.

## Evidence

- active/missions/public/MSN-EXISTING-NAV-20261008/evidence/implementation-report.md
- active/missions/public/MSN-EXISTING-NAV-20261008/evidence/test-report.md
- active/missions/public/MSN-EXISTING-NAV-20261008/evidence/REVIEW-execution-implement.md

## Artifacts

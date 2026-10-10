---
record_id: mem-MSN-COMPANY-SWITCHER-20261010-2026_10_10
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-COMPANY-SWITCHER-20261010-2026_10_10
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-10T13:49:53.369Z
source_branch: feat/company-switcher-20261010
source_commit: f5e590719cfcf0543352204bac4923b694704b24
---

# Narrowing a viewer to a selected tenant must keep company-less items reachable

A tenant selector that narrows the viewer to one tenant (or none for an aggregate) silently hides items that belong to no tenant, such as system-scope approvals. Give all-tenant viewers an explicit system view for untenanted items, and make empty tenant lists mean nothing rather than everything.

## Hint Scope

mission

## Trigger Phrases

- ## Lesson

When a surface adds a tenant (company) selector by narrowing the server-resolved viewer scope:

- **Selection is a hint, never authority.** Read URL then cookie, intersect with the viewer allowed set (explicit scope, or the tenant registry for all-tenant viewers) on every request; a refused URL value falls back to the default, never to the cookie; markers use reserved scope names so no tenant slug can collide.
- **Empty means nothing.** Narrowing to an empty tenant list must hide tenant data in every route; audit each route for `[]` treated as all. An unreadable registry fails closed.
- **Untenanted items need a home.** Records with no tenant (system-scope approvals, hygiene, memory candidates, members without memberships) disappear from every per-tenant and aggregate view, while remaining decidable, so missions stall silently. Give all-tenant viewers a system selection (untenanted only), count it in the aggregate, never pin them to a single tenant, and make the core filter flag opt-in so other surfaces keep their default.
- **Writes authorize against the item own tenant**, not the selection.
- **Per-tab streams** (EventSource) must carry the page selection, not the shared cookie.

## Process note

The first independent review found no widening but caught the untenanted regression; a second pass verified every other caller of the shared filter kept its default.

## Recommended References

- active/missions/public/MSN-COMPANY-SWITCHER-20261010/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-COMPANY-SWITCHER-20261010/evidence/design-spec.json
- active/missions/public/MSN-COMPANY-SWITCHER-20261010/evidence/test-report.md

## Evidence

- active/missions/public/MSN-COMPANY-SWITCHER-20261010/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-COMPANY-SWITCHER-20261010/evidence/design-spec.json
- active/missions/public/MSN-COMPANY-SWITCHER-20261010/evidence/test-report.md

## Artifacts

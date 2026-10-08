---
title: 'Existing front-desk navigation'
tags: [surface, navigation, authorization, user-experience]
last_updated: 2026-10-08
role_affinity: [ecosystem_architect]
---

# Existing front-desk navigation

The shared catalog in [front-desk-nav.ts](../../../libs/core/front-desk-nav.ts) has no fixed item-count limit. Presence Studio and Concierge render the same groups, icons and localized labels. Concierge command search reads the same server-resolved, role-filtered catalog and adds the existing settings section shortcuts.

## Destination inventory

| Group                  | Destination       | Existing route                    | Minimum navigation role |
| ---------------------- | ----------------- | --------------------------------- | ----------------------- |
| Work                   | Home              | Presence Studio /                 | viewer                  |
| Work                   | Ask               | Presence Studio /ask              | approver                |
| Work                   | Decisions         | Concierge /                       | approver                |
| Work                   | Progress          | Presence Studio /progress         | viewer                  |
| Work                   | Workspace         | Presence Studio /work             | viewer                  |
| Work                   | Missions          | Chronos /?section=missions        | viewer                  |
| Work                   | Work items        | Chronos /?section=work-items      | operator                |
| Materials and learning | Deliverables      | Chronos /?section=deliverables    | viewer                  |
| Materials and learning | Import materials  | Concierge /ingest                 | operator                |
| Materials and learning | Knowledge         | Chronos /?section=knowledge       | viewer                  |
| Materials and learning | Discussion        | Chronos /?section=discussion      | viewer                  |
| Materials and learning | First job         | Presence Studio /first-job        | approver                |
| Materials and learning | Help and training | Presence Studio /help             | viewer                  |
| Management             | Organization      | Chronos /?section=organization    | owner                   |
| Management             | Agent operations  | Chronos /?section=operations      | owner                   |
| Management             | Surface controls  | Chronos /?section=surface-control | owner                   |
| Management             | Diagnostics       | Chronos /?section=diagnostics     | owner                   |
| Management             | Settings          | Concierge /settings               | owner                   |

Settings retains its nine existing sections: profile, display, members, services, voice, notifications, recording consent, plugins and advanced settings. Service registration remains under Services. The workspace retains its existing conversation, voice, mail, notification, outcome and browser panels. Contextual mission/detail links stay contextual; redirects, sign-in/join flows and internal API endpoints are not separate feature menu entries.

## Availability is not authorization

The nine Chronos entries require an enabled registry definition, a valid matching local browser origin and a successful bounded health request to that exact origin. Redirects, missing configuration, timeouts and unknown health omit those optional links. No service is started to assemble a menu. Remote-only deployments are conservatively omitted because local health is not evidence that a remote browser URL is reachable.

The Operator surface is deliberately not linked from this tenant-scoped menu: its current UI reads a process-bound tenant, not the selected tenant URL parameter. Its existing standalone navigation is unchanged. A future shortcut must first provide an explicit scope-preserving destination.

Menu visibility is only an aid to discovery. Every destination retains its existing server-side authentication, tenant isolation, member-role and mutation checks. An available endpoint does not grant access or prove that an action is permitted. The local diagnostic and login setup flows still have their own prerequisites; this navigation change creates no credentials, identity bindings, members or approvals.

## Scope and interaction

Links preserve the selected tenant, organization and project. Chronos uses organization_id/project_id; the primary front-desk routes use organizationId/projectId. The shared link metadata selects the correct names. Changing tenant clears both older scope aliases.

Desktop navigation scrolls vertically and mobile navigation horizontally without hiding later groups. Current-page state covers workspace, import, first-job and training routes. Command search supports keyboard selection, dismissal and focus restoration, native settings hash history, and ignores responses superseded by closing, locale changes or tenant changes.

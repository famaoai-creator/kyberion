---
title: 'Existing front-desk navigation'
tags: [surface, navigation, authorization, user-experience]
last_updated: 2026-11-04
role_affinity: [ecosystem_architect]
---

# Existing front-desk navigation

The shared catalog in [front-desk-nav.ts](../../../libs/core/front-desk-nav.ts) has no fixed item-count limit. Presence Studio and Concierge render the same groups, icons and localized labels. Concierge command search reads the same server-resolved, role-filtered catalog and adds the existing settings section shortcuts.

## Destination inventory

| Group                  | Destination         | Existing route                    | Minimum navigation role |
| ---------------------- | ------------------- | --------------------------------- | ----------------------- |
| Work                   | Inbox               | Concierge /                       | approver                |
| Work                   | Ask                 | Presence Studio /ask              | approver                |
| Work                   | Missions            | Concierge /w/mission              | viewer                  |
| Work                   | Work items          | Concierge /w/work_item            | viewer                  |
| Work                   | Approvals           | Concierge /w/approval             | viewer                  |
| Organization           | Overview            | Concierge /w                      | viewer                  |
| Organization           | Organizations       | Concierge /w/organization         | viewer                  |
| Organization           | Projects            | Concierge /w/project              | viewer                  |
| Organization           | People and agents   | Concierge /w/actor                | viewer                  |
| Materials and learning | Deliverables        | Chronos /?section=deliverables    | viewer                  |
| Materials and learning | Import materials    | Concierge /ingest                 | operator                |
| Materials and learning | Knowledge           | Chronos /?section=knowledge       | viewer                  |
| Materials and learning | Discussion          | Chronos /?section=discussion      | viewer                  |
| Materials and learning | First job           | Presence Studio /first-job        | approver                |
| Materials and learning | Help and training   | Presence Studio /help             | viewer                  |
| Management             | Organization editor | Concierge /management             | owner                   |
| Management             | Agent operations    | Chronos /?section=operations      | owner                   |
| Management             | Surface controls    | Chronos /?section=surface-control | owner                   |
| Management             | Diagnostics         | Chronos /?section=diagnostics     | owner                   |
| Management             | Settings            | Concierge /settings               | owner                   |

The Concierge workspace pages (`/w`, `/w/<kind>`, `/w/<kind>/<id>`) read the one workspace graph (`libs/core/surface/workspace-graph.ts`) through `/api/v1/workspace/*`, so every entity shows its lineage (company › organization › project › mission), its contents and the people and agents on it. Presence Studio Home (`/`), Progress (`/progress`) and the legacy `/work` page still exist but are no longer rail entries; Home and Progress stay resolvable for deep links through `FRONT_DESK_LINKED_DESTINATIONS` / `resolveFrontDeskDestination`.

Settings retains its nine existing sections: profile, display, members, services, voice, notifications, recording consent, plugins and advanced settings. Service registration remains under Services. The workspace retains its existing conversation, voice, mail, notification, outcome and browser panels. Contextual mission/detail links stay contextual; redirects, sign-in/join flows and internal API endpoints are not separate feature menu entries.

## Availability is not authorization

The Chronos entries require an enabled registry definition, a valid matching local browser origin and a successful bounded health request to that exact origin. Redirects, missing configuration, timeouts and unknown health omit those optional links. No service is started to assemble a menu. Remote-only deployments are conservatively omitted because local health is not evidence that a remote browser URL is reachable.

The Operator surface is deliberately not linked from this tenant-scoped menu: its current UI reads a process-bound tenant, not the selected tenant URL parameter. Its existing standalone navigation is unchanged. A future shortcut must first provide an explicit scope-preserving destination.

Menu visibility is only an aid to discovery. Every destination retains its existing server-side authentication, tenant isolation, member-role and mutation checks. An available endpoint does not grant access or prove that an action is permitted. The local diagnostic and login setup flows still have their own prerequisites; this navigation change creates no credentials, identity bindings, members or approvals.

## Scope and interaction

Links preserve a concrete selected tenant, organization and project, including when its display profile is absent. Concierge's personal and system overviews are not tenant slugs. Opening a workspace-only destination from either overview first asks the user to choose from the server-listed workspaces and retains the intended destination. Cancel or Escape leaves the source scope and history unchanged. An explicit workspace transition drops the previous organization/project hierarchy, and the destination rechecks authorization. The rail and command search use this same transition. Surface identity comes from the navigation catalog as well as the URL origin, so a shared-origin reverse proxy does not silently change the contract.

The chooser distinguishes pending workspace/catalog reads from settled failures, and keeps a command-search destination that arrives before the rail's reads finish. Navigation role labels describe access, not verified approver identity; the first-job guide explains its separate sign-in and diagnostic-setup requirements and derives its primary next step from current execution and failure state.

Concrete links preserve the selected tenant, organization and project. Chronos uses organization_id/project_id; the primary front-desk routes use organizationId/projectId. The shared link metadata selects the correct names. Changing tenant clears both older scope aliases.

Desktop navigation scrolls vertically and mobile navigation horizontally without hiding later groups. Current-page state covers workspace, import, first-job and training routes. Command search supports keyboard selection, dismissal and focus restoration, native settings hash history, and ignores responses superseded by closing, locale changes or tenant changes.

## Leaving edited settings

The existing grouped profile, service-preparation and notification drafts remain owned by the Settings page. App-controlled same-tab links, command-search destinations and workspace switches ask whether to keep editing or discard before leaving when those drafts are dirty. A workspace switch waits for that choice before changing the selection cookie. Cancel and Escape retain the edits, URL and scope; an accepted exit runs once. No draft content is copied to persistent storage.

A save in progress keeps the page protected even if fields were edited back to their previous values. The leave dialog waits for its result and never claims to cancel a submitted request or leaves automatically when a save settles. Known context invalidation and page unmount cancel queued navigation.

Same-page section links and hash Back/Forward retain native behavior. Modifier clicks, new tabs and downloads do not discard the current page and remain unchanged. Reload, closing the tab and full-document departure use the browser-controlled beforeunload warning where supported. Same-document browser Back/Forward to another client-rendered route cannot reliably be canceled across supported browsers and is not intercepted: no sentinel history entries or reverse-traversal loops are added. Authentication redirects and the OAuth flow retain their existing behavior.

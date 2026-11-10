---
title: 'Surface roles: Concierge vs Presence Studio (and Chronos Mirror)'
tags: [surfaces, architecture, concierge, presence-studio, roles]
last_updated: 2026-11-08
concepts: [surface, concierge, front-desk]
---

# Surface roles: Concierge vs Presence Studio (and Chronos Mirror)

Investigation for MSN-PRESENCE-E2E-20261103. Question raised: concierge and
presence-studio overlap — "couldn't it be one?". Verdict: **not yet**. They
overlap in _function names_, not in _operating role_; merging today would
collapse two different trust and lifecycle boundaries into one process.

## What each surface actually is (code, not manifest)

| Axis                 | Concierge (`:3050`)                                                                                                            | Presence Studio (`:3031`)                                                                                                                                                                                                 | Chronos Mirror V2 (`:3000`)                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Manifest description | operator front-desk                                                                                                            | "subtitles, transcript, voice presence" (**stale**)                                                                                                                                                                       | mirror surface                                 |
| Process model        | Next.js app + `server/local-server.ts`                                                                                         | single `dist/.../server.js`, mostly static + JSON routes                                                                                                                                                                  | Next.js app                                    |
| Primary user         | the operator (signed-in member)                                                                                                | the operator + _attended_ voice/hearing sessions                                                                                                                                                                          | ambient display                                |
| Core modules         | intent inbox, approvals, outcomes, exceptions, settings (26 panels), onboarding authority, services, org management, first-job | hearing (`hearing-*`), ask views (`ask-*`), approval inbox (`approval-inbox-routes`), conversation routes, component host (A2UI), avatar, engine config, training, service bindings, work home/inventory, front-desk rail | A2UI component library showcase + mirror views |
| Realtime             | none (polling HTTP)                                                                                                            | hearing runtime is the realtime voice loop                                                                                                                                                                                | display                                        |

The manifest one-liners understate both surfaces: presence-studio is a
second operator surface in practice, not a caption overlay.

## Overlap (real)

- **Approval inbox**: presence-studio has `approval-inbox-routes.ts`;
  concierge has the approvals UI. Both read the same channel store.
- **Service binding**: `service-bindings-route.ts` in studio vs the services
  section in concierge.
- **Engine/engine-config + member resolution** in studio duplicates concerns
  concierge settings also owns.
- **Front-desk routes** exist in _both_ (`front-desk-routes.ts` in studio vs
  concierge's whole app).

## Non-overlap (why one process is premature)

- **Realtime voice/hearing**: studio serves the hearing routes (the hearing
  logic itself — `hearing-runtime`, completion/handoff/recovery, and the route
  steps in `hearing-session-service` / `-mission-service` / `-ledger-service` —
  lives in `libs/core/surface/hearing-*.ts`). Concierge serves the same
  `/api/hearing/*`, `/api/conversation` and `/api/ask-vocabulary` from those
  steps behind its own gate (`src/lib/hearing-access.ts`: the installation
  owner decides "the owner", passed to core as `owner`), ahead of moving the
  `/ask` page (MSN-SERVER-CONCIERGE-ASK-20261108). Decision-ledger hearings
  fail closed there: the concierge role may not assume `decision_ledger`
  (CD-12). The realtime voice loop stays a live session lifecycle with its own
  failure domain. Folding it into the Next.js concierge couples the
  slow-moving settings app to the realtime loop's crash/restart surface.
- **A2UI host**: `component-host-routes` + core `hearing-a2ui` make studio the
  in-process renderer/host for agent-composed UIs. Concierge is a typed
  Next app — different rendering contracts.
- **Trust tiers**: concierge = member-authenticated operator console.
  Studio additionally fronts _attended-session_ flows (hearing decisions,
  ask corrections) that run while a session is live.
- **Lifecycle**: studio is `startupMode: workspace-app` detached; concierge
  is the always-on front desk. Different restart/SLO profiles.

## Recommendation (investigation-first, per operator decision)

1. **Keep two processes.** Merge is not justified until the hearing/realtime
   lifecycle is separable from the front-desk lifecycle.
2. **Deduplicate the shared read surfaces** instead: approval inbox,
   service bindings, and member/engine config should be served by one
   backend module consumed by both surfaces, so there is one source of
   truth even though there are two windows onto it.
3. **Fix the manifests** — `description`, `bestForKey` for studio should
   name hearing/realtime/A2UI host, not "subtitles". Stale manifests are
   part of why surfaces drift (see MSN-PRESENCE-E2E repair evidence).
4. **Chronos Mirror** stays a display surface; its value is the A2UI
   component library, which should feed the shared component host rather
   than live only inside chronos-mirror-v2.

## Update — unified shell (MSN-SURFACE-UNIFY-20261103)

The recommendations above were carried out as follows:

- **One shell, three processes.** Concierge hosts the workspace shell (`/w` overview, `/w/<kind>` lists, `/w/<kind>/<id>` detail with lineage and actors). Presence Studio stays the realtime voice/hearing process, and its root redirects to the shell. Chronos keeps operations, surface control, diagnostics, deliverables and knowledge, and renders the shared rail, so every page links back.
- **One read API.** `libs/core/surface/surface-operation-registry.ts` declares each operation once. Concierge serves it at `/api/v1/<domain>/<verb>` and the MCP server as `kyberion.<id>`. The read model is `libs/core/surface/workspace-graph.ts`, run as the read-only role `workspace_graph_reader`.
- **One sign-in.** The `kyberion_session` cookie is shared across ports on the same host, and all three surfaces read the operator-wide OIDC settings in system scope.
- **Installation-scope settings** are authorized by owner identity and assurance; see [installation-owner-authorization](../governance/installation-owner-authorization.md).

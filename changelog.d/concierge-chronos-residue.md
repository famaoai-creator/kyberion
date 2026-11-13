---
category: Changed
---

- **Concierge / Chronos residue cleanup** — no screen or route changes; a few machine-readable details did:
  - `GET /api/setup` (Concierge) `setup.surface_roles` now mirrors the surface manifests: `customer-room` is listed (`enabled: false`), `operator-surface` is `enabled: false`, and `chronos-mirror-v2` is described as the compatibility redirect it is (new `name_ja` / `name_en` / `role_ja` / `tagline_ja` / `metaphor`, `writes` `scoped` → `none`).
  - `pnpm kyberion chronos dev` help text now says it runs the Chronos redirect app; the operations console is Concierge `/ops`.
  - `GET /api/front-desk/nav` (Concierge and presence-studio) no longer makes a health request to Chronos on every call. The payload is identical.
  - `@agent/core/front-desk-nav` no longer exports `readAvailableFrontDeskSurfaces`, `FrontDeskOptionalSurfaceId` or `FrontDeskAvailableSurfaces`; `resolveFrontDeskMenu` / `resolveFrontDeskDestination` no longer take `availableSurfaces`, and `FrontDeskSurfaceId` is `'presence-studio' | 'concierge'` (no menu item used the two removed members).
  - Removed Concierge operations-console components that no page imported (`SovereignChat`, `ChronosHome`, `ApprovalsWorkspace`, `WorkItemsWorkspace`, `OrganizationDashboard`, `WorkspaceOverview`, `CloudflareOsPanel`, `FirstRunBanner`) and their private helpers. Their `/api/ops` routes stay.

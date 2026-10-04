---
category: Added
---

- **Authenticated event intake for resident dots (DL-08)** — new `scripts/event_intake_surface.ts` listens on `127.0.0.1:8791` (`KYBERION_EVENT_INTAKE_HOST` / `KYBERION_EVENT_INTAKE_PORT`) for `POST /events/<source>`, verifies an HMAC-SHA256 signature per source, and appends each delivery once to the dot events ledger (tenant-scoped when the source is bound to a tenant in policy). Dot charters with `event` triggers wake once per matching event (`event:<event_id>`). Every source in `knowledge/product/governance/event-intake-policy.json` is disabled by default and the surface is registered as operator-launched (`enabled: false`). Action needed only to use it: enable a source, store its `EVENT_INTAKE_*` secret, and start the surface.

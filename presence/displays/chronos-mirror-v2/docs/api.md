# Chronos Mirror v2 — compatibility redirects

The operations console that Chronos served moved into Concierge
(MSN-KYBERION-SERVER-20261104):

| Old (Chronos, port 3000) | New (Concierge origin)       |
| ------------------------ | ---------------------------- |
| `/?section=<id>`         | `/ops?section=<id>`          |
| `/discussion`            | `/ops/discussion`            |
| `/api/<path>`            | `/api/ops/<path>`            |
| `/api/healthz`           | unchanged, served by Chronos |

The Chronos process answers every other request with a `308` to the Concierge
origin (`resolveSurfaceBrowserUrl('concierge')`), keeping the query string,
method and body. Authorization happens on Concierge: the `/api/ops` routes
resolve the Concierge viewer, and localadmin writes pass the Concierge
mutation gate (same origin or a configured operator token).

Any other page path also redirects to `/ops`. If the Concierge URL cannot be
resolved, the redirect answers `503` with a JSON error instead. The route
handlers now live in `presence/displays/concierge/src/app/api/ops/`; the
redirect rules are in `src/proxy.ts` of this app.

# chronos-mirror-v2 — compatibility redirect app

The operations console that used to live here (Chronos Mirror v2) moved into
Concierge (`presence/displays/concierge`, port 3050) in
MSN-KYBERION-SERVER-20261104: pages at `/ops`, API at `/api/ops/*`.

This app keeps port 3000 only so old bookmarks and scripts land on the new
origin (`src/proxy.ts`):

- `/api/healthz` — served locally (surface health probe)
- `/api/<path>` — `308` to Concierge `/api/ops/<path>`
- `/discussion` — `308` to Concierge `/ops/discussion`
- any other path — `308` to Concierge `/ops`

The query string is preserved. Nothing is authorized here; Concierge applies
its own viewer and mutation gates. `pnpm chronos:dev` starts only this app;
start the console itself with `pnpm surfaces reconcile` or
`pnpm --dir presence/displays/concierge dev`.

See [docs/api.md](./docs/api.md).

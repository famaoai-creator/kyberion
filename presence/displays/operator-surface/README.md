# Minimum Operator Surface (MOS)

Read-only Web operator surface for Kyberion. CLI is the primary interface;
this app exists to give operators and non-operator stakeholders (CEO,
compliance) a visual view of mission state, audit chain, and health
**without** introducing a mutation surface.

Strategy: [`knowledge/public/architecture/operator-surface-strategy.md`](../../../knowledge/public/architecture/operator-surface-strategy.md)

## What this MVP includes

| Page | Purpose |
|---|---|
| `/` | Mission list, scoped by `KYBERION_TENANT` |
| `/missions/:id` | Mission detail: history, checkpoints, evidence, copy-able commands |
| `/audit` | Audit-chain timeline (filtered by tenant) |
| `/health` | Mission counts, recent audit volume, override events |
| `/intent-snapshots` | Placeholder for the diff view (full implementation deferred) |
| `/knowledge` | Public-tier knowledge browser |

The data layer (`src/lib/data.ts`) imports **only** read APIs from
`@agent/core/secure-io`:

```ts
import {
  safeReadFile,
  safeReaddir,
  safeExistsSync,
  safeLstat,
  pathResolver,
} from '@agent/core/secure-io';
```

A contract test (`test/no-write-api.test.ts`) scans every TS / TSX file
under `src/` and fails if any of `safeWriteFile`, `safeMkdir`,
`safeAppendFileSync`, etc. appear. This guard is acceptance-gating per
[`operator-surface-strategy.md` §9.1](../../../knowledge/public/architecture/operator-surface-strategy.md#91-security-baseline-mandatory-before-any-external-exposure).

## Acceptance criteria status

From [`operator-surface-strategy.md` §9](../../../knowledge/public/architecture/operator-surface-strategy.md#9-acceptance-criteria-for-mos-shipped):

- [x] No write API in the app's network surface
- [x] Renders mission list, mission detail, audit timeline, health,
      knowledge index
- [x] Multi-tenant: `KYBERION_TENANT` filters all data sources
- [x] Actions surfaced via copy-able `suggested_command`
- [x] CI runs MOS-side tests as part of `pnpm run validate`
      (`check:mos-no-write-api` step in root validate)

§9.1 Security baseline (mandatory before external exposure):

- [x] Filesystem read sandbox: write APIs are statically forbidden
      (no-write-api.test.ts)
- [x] SSRF guard: outbound network primitives statically forbidden
      (ssrf-guard.test.ts — fetch / node:http / axios / node-fetch /
      undici imports all rejected)
- [x] `mos.read` audit events — every Server Component page emits a
      `mos.read` audit-chain event via the single `src/lib/audit-mos.ts`
      chokepoint; the contract test enforces that no other source file
      touches `auditChain.record`
- [ ] WAF placement — deployment-time concern, see §Deployment below
- [ ] Client cert / OIDC + tenant scope — deployment-time, see §Auth
- [ ] Independent auth review — deployment-time

The remaining items are deployment posture, not code; document them in
the operator's runbook before exposing the MOS beyond loopback.

## Local development

```bash
cd presence/displays/operator-surface
pnpm install        # if not already
pnpm dev            # http://localhost:3331
```

By default the dev server binds to all interfaces. To restrict to
loopback (recommended for any deployment touching real tenant data):

```bash
pnpm next dev -H 127.0.0.1 -p 3331
```

## Tenant scoping

Set `KYBERION_TENANT` in the environment before starting the server:

```bash
KYBERION_TENANT=acme-corp pnpm dev
```

When set, every loader filters mission state and audit events to that
tenant only. Public-tier missions remain visible (cross-tenant tooling).
There is **no UI control** to switch tenants — that boundary is
intentional.

When unset, the server runs in tenant-agnostic mode and shows all
non-personal missions. Acceptable for development; not acceptable for
multi-tenant production.

## Deployment notes

- **Networking**: bind to loopback or place behind a WAF. The MOS does
  not implement its own auth — relying on the perimeter (corporate VPN,
  reverse proxy with OIDC, mTLS) is the documented path.
- **Per-tenant deployment**: run one MOS process per tenant, each with
  its own `KYBERION_TENANT`. The server reads `KYBERION_TENANT` once and
  filters everything; do not expose a multi-tenant aggregate.
- **No mutating endpoints**: `pnpm test:no-write-api` enforces this.
  Run it in CI to keep the property over time.

## Tests

```bash
pnpm test                    # vitest (no-write-api contract)
pnpm test:no-write-api       # alias
```

## What is intentionally out of scope

- Editing mission state. Use `mission_controller` CLI.
- Approving / rejecting memory candidates. Use `memory-approve` CLI.
- Triggering pipelines. Use `pnpm pipeline ...`.
- Cross-tenant aggregation views.
- Public exposure without a WAF / auth perimeter.

These omissions are not gaps — they are the design.

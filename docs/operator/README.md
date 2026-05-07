# Kyberion — Operator Docs

For people **deploying / running** Kyberion in service. If you're using it, see [`../user/`](../user/). If you're extending it, see [`../developer/`](../developer/).

## Start here

| Doc | When to read |
|---|---|
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Deploy on macOS / Linux / Docker. |
| [INITIALIZATION.md](../INITIALIZATION.md) | First-time setup walkthrough. |
| [OPERATOR_UX_GUIDE.md](../OPERATOR_UX_GUIDE.md) | Daily operations: Slack, Chronos, terminal, directories. |
| [PRIVACY.md](../PRIVACY.md) / [PRIVACY.ja.md](../PRIVACY.ja.md) | Data flow + telemetry policy you should explain to your users. |
| [PERFORMANCE_DASHBOARD.md](../PERFORMANCE_DASHBOARD.md) | (Historical snapshot) skill telemetry trends. |

## Scope

Operational documentation: install, deploy, monitor, upgrade, decommission. Phase C'-1 of `docs/PRODUCTIZATION_ROADMAP.md` will consolidate / dedupe with `knowledge/public/operations/` over time.

Current state:

- ✅ `docs/operator/DEPLOYMENT.md` (this directory)
- ✅ `docs/INITIALIZATION.md`
- ✅ `docs/OPERATOR_UX_GUIDE.md`
- ✅ `docs/PRIVACY.md`
- ⏳ Runbooks consolidation from `knowledge/public/operations/runbooks/` (TODO).
- ⏳ SLO / observability guide (Phase B-1 / B-2 follow-up).
- ⏳ Backup / DR playbook (TODO).

## See also

- [`MAINTAINERS.md`](../../MAINTAINERS.md) — who to escalate to.
- [`SECURITY.md`](../../SECURITY.md) — vulnerability disclosure.

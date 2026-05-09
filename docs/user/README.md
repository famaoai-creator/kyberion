# Kyberion — User Docs

For people **using** Kyberion to get work done. If you're trying to operate / deploy it, see [`../operator/`](../operator/). If you're extending it, see [`../developer/`](../developer/).

## Start here

| Doc | When to read |
|---|---|
| [WHY.md](../WHY.md) | First. What is this thing and why does it exist. |
| [QUICKSTART.md](../QUICKSTART.md) | Then. 5 minutes from clone to first working smoke. |
| [USE_CASES.md](../USE_CASES.md) | Browse the catalog of automated workflows you can ask Kyberion to do. |
| [customer-overlay-use-cases.md](./customer-overlay-use-cases.md) | Customer overlay story: create, inspect, activate, onboard, and switch engagements. |
| [meeting-facilitator.md](./meeting-facilitator.md) | How Kyberion joins meetings, keeps consent boundaries, and handles follow-up. |
| [OPERATOR_UX_GUIDE.md](../OPERATOR_UX_GUIDE.md) | Daily operations from the operator perspective (Slack, Chronos, terminal). |

## Scope of this directory

The English-first user-facing docs. Phase C'-1 of `docs/PRODUCTIZATION_ROADMAP.md` will move the right docs here from `docs/` and `knowledge/`. The current state is mid-migration:

- ✅ `docs/WHY.md` (en/ja)
- ✅ `docs/QUICKSTART.md` (first-win smoke and setup)
- ✅ `docs/USE_CASES.md` (Japanese)
- ✅ `docs/user/customer-overlay-use-cases.md` (customer overlay story)
- ✅ `docs/PRIVACY.md` (en/ja)
- ✅ `docs/user/meeting-facilitator.md` (meeting use-case and safety boundaries)
- ⏳ `docs/HOWTO.md` — to be split into per-task user docs.
- ⏳ Troubleshooting guide — to be created.
- ⏳ Slack / Chronos / Terminal user-facing guides — to be split out from `OPERATOR_UX_GUIDE.md`.

Until migration completes, this README is a pointer to where the canonical doc lives.

## What lives in `knowledge/` vs `docs/`

- `docs/` — for humans. Hand-written, narrative, intended to be read top-to-bottom.
- `knowledge/public/` — for the Kyberion runtime to reference. Structured JSON / YAML / markdown indexed by Wisdom-actuator. Not optimized for human onboarding.

If you find yourself reading from `knowledge/public/` to understand what to do, that's a docs gap — please file an issue with `docs` label.

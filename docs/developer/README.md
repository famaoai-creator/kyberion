# Kyberion — Developer Docs

For people **extending or contributing to** Kyberion. If you're using it, see [`../user/`](../user/). If you're deploying it, see [`../operator/`](../operator/).

## Start here

| Doc | When to read |
|---|---|
| [EXTENSION_POINTS.md](./EXTENSION_POINTS.md) | What's stable, what's beta, what's internal. **Read first** before patching anything. |
| [ROLE_PERSONA_MATRIX.md](./ROLE_PERSONA_MATRIX.md) | How to reason about personas, authority roles, and what they do not imply. |
| [CUSTOMER_AGGREGATION.md](./CUSTOMER_AGGREGATION.md) / [.ja.md](./CUSTOMER_AGGREGATION.ja.md) | How per-customer config layers on top of the codebase. |
| [TRACE_MIGRATION_TEMPLATE.md](./TRACE_MIGRATION_TEMPLATE.md) | How to add Trace observability to an existing actuator. |
| [MISSION_LIFECYCLE_AUDIT.md](./MISSION_LIFECYCLE_AUDIT.md) | Why the mission lifecycle is shaped the way it is. |
| [GOLDEN_OUTPUT_CHECK.md](./GOLDEN_OUTPUT_CHECK.md) | Semantic regression detection for stable pipelines. |
| [CHAOS_DRILLS.md](./CHAOS_DRILLS.md) | Recurring failure-injection runs. |
| [VOICE_FIRST_WIN.md](./VOICE_FIRST_WIN.md) | Tier-0 voice setup (Phase A-5). |
| [REGISTRY_SPLIT_PLAN.md](./REGISTRY_SPLIT_PLAN.md) | Taskized backlog for moving global catalogs to per-item canonical files. |
| [RELEASE_OPERATIONS.md](./RELEASE_OPERATIONS.md) | How releases get cut. |
| [GOOD_FIRST_ISSUES.md](./GOOD_FIRST_ISSUES.md) | Starter slices for first-time contributors. |
| [PRODUCTION_READINESS_PLAN.ja.md](./PRODUCTION_READINESS_PLAN.ja.md) | Implementation backlog and verification scenarios before production-grade OSS release. |
| [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) | The PR contract. (Currently being refreshed in Phase C'-3.) |
| [`../../GOVERNANCE.md`](../../GOVERNANCE.md) | How decisions get made. |
| [`../../MAINTAINERS.md`](../../MAINTAINERS.md) | Who reviews what. |

## Architecture

The deep architecture lives in `knowledge/public/architecture/` — 92 docs of historical and current design. The most useful entry points:

| Doc | What it covers |
|---|---|
| [`organization-work-loop.md`](../../knowledge/public/architecture/organization-work-loop.md) | The thesis. The model from which everything else derives. |
| [`agent-mission-control-model.md`](../../knowledge/public/architecture/agent-mission-control-model.md) | How missions / agents / actuators relate. |
| [`enterprise-operating-kernel.md`](../../knowledge/public/architecture/enterprise-operating-kernel.md) | The kernel layer above missions. |
| [`ceo-ux.md`](../../knowledge/public/architecture/ceo-ux.md) | The user-facing interaction model. |

Phase C'-1 of `PRODUCTIZATION_ROADMAP.md` will consolidate these 92 docs into a smaller "1 hour to read" tour. Until then, the above 4 are the recommended entry points.

## Building on Kyberion

If you're authoring an actuator or a vertical template:

| Need | Doc |
|---|---|
| New actuator / plugin | [`PLUGIN_AUTHORING.md`](./PLUGIN_AUTHORING.md) |
| New vertical template | [`templates/verticals/README.md`](../../templates/verticals/README.md) |
| Adding Trace to an existing actuator | [`TRACE_MIGRATION_TEMPLATE.md`](./TRACE_MIGRATION_TEMPLATE.md) |
| Customer-specific config | [`CUSTOMER_AGGREGATION.md`](./CUSTOMER_AGGREGATION.md) |

## Scope

All developer-oriented docs now live under this directory. The legacy `docs/architecture/`, `docs/playbooks/`, `docs/design/` were consolidated here on 2026-05-07 (Phase C'-1). The 92 architecture docs in `knowledge/public/architecture/` remain as system-referenced material; see [`TOUR.md`](./TOUR.md) §5 for the recommended entry points.

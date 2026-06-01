---
title: Organization Selection Guide
category: Orchestration
tags: [orchestration, organization, mission, team, cli, defaults]
importance: 8
author: Ecosystem Architect
last_updated: 2026-06-01
---

# Organization Selection Guide

## 1. Purpose

Kyberion can operate under multiple organization profiles.
An organization profile defines the stable defaults for:

- mission composition
- team template selection
- agent preference bias
- template catalog overlays
- organization-level LLM preferences

This guide explains how to select the active organization at the CLI boundary and how the resolution order works.

If you only need the shortest command map, start with
[Orchestration Index](README.md). If you need the machine-readable payload
contracts, open [Organization Discovery Reports](organization-discovery-reports.md).
For JSON inventory examples, jump straight to the discovery reports section in
[Orchestration Index](README.md).
For copy/paste commands, use the Organization Discovery Copy/Paste table in
[Orchestration Index](README.md).

Fast path:

- `node dist/scripts/mission_controller.js organization-discovery`
- `node dist/scripts/mission_controller.js organization-profile --summary`
- `node dist/scripts/mission_controller.js organization-profiles --summary`
- `node dist/scripts/mission_controller.js organization-catalogs --selected-only --summary`

JSON fast path:

- `node dist/scripts/mission_controller.js organization-discovery --json`
- `node dist/scripts/mission_controller.js organization-profile --json --summary`
- `node dist/scripts/mission_controller.js organization-profiles --json --summary`
- `node dist/scripts/mission_controller.js organization-catalogs --json --selected-only --summary`

If you need machine-readable output instead of the compact summaries, add
`--json` to the same commands and then inspect the matching report schema in
[Organization Discovery Reports](organization-discovery-reports.md).

Common questions:

| Question | Best Command |
| --- | --- |
| "What organization is selected right now?" | `organization-profile --summary` |
| "Which customer orgs are missing a profile?" | `organization-profiles --missing-only --summary` |
| "Which team template overlays are active for this org?" | `organization-catalogs --selected-only --summary` |
| "Do I need JSON for another tool?" | add `--json` to the same command and use the matching report schema |

## 2. Resolution Order

When a command resolves organization-scoped behavior, the order is:

```text
CLI organization-id / org override
-> KYBERION_CUSTOMER environment context
-> knowledge/public/governance/organization-profile.json
-> builtin fallback
```

The organization profile is declarative.
It does not replace governed policies or mission-specific planning.

## 3. Supported Switches

The following CLI options select the organization context for mission and team operations:

- `--organization-id <ORG>`
- `--org <ORG>`

These options currently apply to:

- `mission_controller create`
- `mission_controller start`
- `mission_controller team`
- `mission_controller staff`
- `mission_controller prewarm`
- `compose_mission_team`

## 4. What Changes When You Switch

Once an organization is selected, Kyberion can apply:

- `mission_defaults.default_team_template`
- `mission_defaults.default_agent_profile`
- `team_defaults.team_template_catalog_id`
- `team_defaults.default_lifecycle_template`
- `llm.profile_overrides`

That affects:

- which team template is used as the default
- which optional roles are introduced by an organization catalog
- which agent profile is preferred when filling roles
- which organization-specific backend or LLM preference is used

When you inspect a mission with `mission_controller team` or `mission_controller staff`,
the CLI now prints a short human-readable summary before the JSON artifact:

- organization name and id
- default team template and catalog
- template catalog count
- selected catalog template ids
- assignment counts
- staffing status counts

The JSON artifact remains available after the summary for downstream tooling.

## 5. Examples

Create a mission under a specific organization:

```bash
node dist/scripts/mission_controller.js create MSN-ORG-001 \
  --organization-id demo-org \
  --mission-type development \
  --persona "Ecosystem Architect"
```

Inspect the team plan for that organization:

```bash
node dist/scripts/mission_controller.js team MSN-ORG-001 \
  --organization-id demo-org
```

Inspect the current staffing runtime for that organization:

```bash
node dist/scripts/mission_controller.js staff MSN-ORG-001 \
  --organization-id demo-org
```

Compose a mission team brief with the same org defaults:

```bash
pnpm exec tsx scripts/compose_mission_team.ts \
  --mission-id MSN-ORG-001 \
  --organization-id demo-org \
  --mission-type development \
  --write
```

List the available organization team template catalogs:

```bash
node dist/scripts/mission_controller.js organization-catalogs
```

Show the catalogs as JSON:

```bash
node dist/scripts/mission_controller.js organization-catalogs --json
```

Show only the selected catalog for the active organization:

```bash
node dist/scripts/mission_controller.js organization-catalogs \
  --selected-only
```

Show only the catalog summary counts:

```bash
node dist/scripts/mission_controller.js organization-catalogs \
  --summary
```

The catalog inventory JSON also includes a `summary` object with total,
selected, template, and role counts.

List the available organization profiles:

```bash
node dist/scripts/mission_controller.js organization-profiles
```

Show the inventory as JSON:

```bash
node dist/scripts/mission_controller.js organization-profiles --json
```

Show the inventory as if a specific organization were active:

```bash
node dist/scripts/mission_controller.js organization-profiles \
  --organization-id demo-org
```

The organization-scoped inventory keeps the same roster, but it marks the
requested organization as the selected context in the summary and JSON output.

The inventory JSON also includes a `summary` object with total/ready/missing
and source counts so operators can see readiness at a glance.

Show only the active organization profile:

```bash
node dist/scripts/mission_controller.js organization-profiles \
  --active-only
```

Show only ready profiles:

```bash
node dist/scripts/mission_controller.js organization-profiles \
  --ready-only
```

Show only missing profiles:

```bash
node dist/scripts/mission_controller.js organization-profiles \
  --missing-only
```

Show only the profile summary counts:

```bash
node dist/scripts/mission_controller.js organization-profiles \
  --summary
```

Filter the inventory to customer overlays only:

```bash
node dist/scripts/mission_controller.js organization-profiles \
  --source customer
```

The machine-readable JSON outputs are governed by these schemas:

- `knowledge/public/schemas/organization-catalog-report.schema.json`
- `knowledge/public/schemas/organization-profile-report.schema.json`
- `knowledge/public/schemas/organization-profiles-report.schema.json`

See also:

- `knowledge/public/orchestration/README.md`
- `knowledge/public/orchestration/organization-discovery-reports.md`

Inspect the catalogs as if a specific organization were active:

```bash
node dist/scripts/mission_controller.js organization-catalogs \
  --organization-id demo-org
```

If no organization-specific profile overlay exists for the requested id
(for example, `--organization-id unknown-org`), Kyberion falls back to the
public default profile and reports that resolution explicitly in the output.

Show the resolved organization profile and defaults:

```bash
node dist/scripts/mission_controller.js organization-profile \
  --organization-id demo-org
```

Show the resolved organization profile as JSON:

```bash
node dist/scripts/mission_controller.js organization-profile \
  --organization-id demo-org \
  --json
```

Show only the compact summary:

```bash
node dist/scripts/mission_controller.js organization-profile \
  --organization-id demo-org \
  --summary
```

The compact summary includes the selected catalog template ids so you can see
which overlay is active without reading the full JSON payload.

Use `organization-profiles` when you want to inventory the available
organizations first, and `organization-profile` when you want to inspect one
specific organization in detail.

## 6. Files Involved

The main files are:

- `knowledge/public/governance/organization-profile.json`
- `knowledge/public/governance/organization-team-template-catalogs/README.md`
- `knowledge/public/governance/organization-team-template-catalogs/*.json`
- `knowledge/public/schemas/organization-catalog-report.schema.json`
- `knowledge/public/schemas/organization-profile-report.schema.json`
- `knowledge/public/schemas/organization-profiles-report.schema.json`
- `knowledge/public/orchestration/organization-discovery-reports.md`
- `knowledge/public/orchestration/README.md`
- `knowledge/public/orchestration/mission-team-templates.json`
- `libs/core/organization-profile.ts`
- `libs/core/mission-team-index.ts`
- `libs/core/mission-team-plan-composer.ts`
- `scripts/refactor/mission-runtime.ts`
- `scripts/mission_controller.ts`
- `scripts/compose_mission_team.ts`

## 7. Practical Advice

- Use `--organization-id` when you want to evaluate a different organization profile without changing the environment permanently.
- Use `KYBERION_CUSTOMER` when you want a durable organization context for a shell session.
- Keep organization profiles declarative; keep execution logic in actuators and mission composition code.
- Treat the JSON inventory/detail outputs as contracts, not ad-hoc debug dumps.

## 8. Template Catalog Examples

The organization team template catalog is an overlay, not a replacement.
It only overrides template entries that the organization wants to specialize.

### `default`

- catalog id: `default`
- overlay file: `knowledge/public/governance/organization-team-template-catalogs/default.json`
- behavior: no overlay entries, so the base mission team templates are used as-is

### `demo-org`

- catalog id: `demo-org`
- overlay file: `knowledge/public/governance/organization-team-template-catalogs/demo-org.json`
- behavior: specializes the `development` template

For `development`, the `demo-org` overlay changes:

- optional roles: adds `operator` and `surface_liaison`
- lifecycle limits: raises parallel members, max members, message budget, wall clock, and member turns
- cooldown: increases the cooldown to keep the team running longer between handoffs

Use this pattern when a specific organization needs a more opinionated team shape than the global default.

### `ops-org`

- catalog id: `ops-org`
- overlay file: `knowledge/public/governance/organization-team-template-catalogs/ops-org.json`
- behavior: specializes the `operations` and `incident` templates

For `operations`, the `ops-org` overlay:

- adds `tester`, `surface_liaison`, and `decision_maker` as optional roles
- raises the team budget and runtime horizon for longer operational runs

For `incident`, the `ops-org` overlay:

- adds `planner`, `tester`, and `surface_liaison` as optional roles
- increases the team budget so incident handling can absorb more coordination overhead

Use this pattern when a specific organization runs more operations-heavy or incident-prone work than the base catalog assumes.

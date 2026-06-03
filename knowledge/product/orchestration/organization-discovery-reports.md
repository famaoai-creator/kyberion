---
title: Organization Discovery Reports
category: Orchestration
tags: [orchestration, organization, cli, json, contracts]
importance: 7
author: Ecosystem Architect
last_updated: 2026-06-01
---

# Organization Discovery Reports

This document is the machine-readable inventory index for organization selection
and discovery commands.

If you arrived from the orchestration index, this page is the command matrix
and report contract reference for organization inventory. For the shortest
command map, return to [Orchestration Index](README.md).
For copy/paste commands, use the Organization Discovery Copy/Paste table in
[Orchestration Index](README.md).

Related entry points:

- [Orchestration Index](README.md)
- [Organization Selection Guide](organization-selection-guide.md)

## 0. At a Glance

| Command | Best For | Common Filters | Output Modes |
| --- | --- | --- | --- |
| `organization-catalogs` | Inspect selected team template overlays | `--selected-only`, `--summary`, `--organization-id <ORG>` | table, JSON |
| `organization-profile` | Inspect one resolved organization profile | `--organization-id <ORG>`, `--summary` | detail, JSON |
| `organization-profiles` | Inventory organizations and readiness | `--organization-id <ORG>`, `--active-only`, `--ready-only`, `--missing-only`, `--source <customer|public>`, `--summary` | table, JSON |
| `organization-discovery` | Inspect the discovery overview and entrypoints | `--summary`, `--json` | overview, compact, JSON |

## 0.1. Canonical JSON Modes

If you are wiring another tool or want stable machine-readable output, start with these forms:

- `node dist/scripts/mission_controller.js organization-catalogs --json --selected-only --summary`
- `node dist/scripts/mission_controller.js organization-profile --json --summary`
- `node dist/scripts/mission_controller.js organization-profiles --json --summary`
- `node dist/scripts/mission_controller.js organization-discovery --json`

## 0.2. Fast Path

Use these if you want the compact human-readable summaries first:

- `node dist/scripts/mission_controller.js organization-discovery --summary`
- `node dist/scripts/mission_controller.js organization-catalogs --selected-only --summary`
- `node dist/scripts/mission_controller.js organization-profile --summary`
- `node dist/scripts/mission_controller.js organization-profiles --summary`

Use these if you want the same results in JSON:

- `node dist/scripts/mission_controller.js organization-catalogs --json --selected-only --summary`
- `node dist/scripts/mission_controller.js organization-profile --json --summary`
- `node dist/scripts/mission_controller.js organization-profiles --json --summary`

## 0.3. Common Questions

| Question | Best Report | Best Command |
| --- | --- | --- |
| What organization is selected right now? | `organization-profile` | `node dist/scripts/mission_controller.js organization-profile --summary` |
| Which customer orgs are missing a profile? | `organization-profiles` | `node dist/scripts/mission_controller.js organization-profiles --missing-only --summary` |
| Which team template overlays are active for this org? | `organization-catalogs` | `node dist/scripts/mission_controller.js organization-catalogs --selected-only --summary` |
| Which organization profiles are ready to use? | `organization-profiles` | `node dist/scripts/mission_controller.js organization-profiles --ready-only --summary` |

## 0.4. Overview Schema

The report schemas and examples are paired one-to-one. Use the schema when
you need the contract shape and the example when you want a concrete payload.
The `organization-discovery` report also includes an `examples` array so
machine readers can surface the same canonical example set the docs reference.

| Report | Schema | Canonical Example | Use When |
| --- | --- | --- | --- |
| `organization-discovery` | `knowledge/product/schemas/organization-discovery-report.schema.json` | [organization-discovery-report.example.json](../schemas/organization-discovery-report.example.json) | You want the orchestration overview and operator entrypoints. |
| `organization-profile` | `knowledge/product/schemas/organization-profile-report.schema.json` | [organization-profile-report.example.json](../schemas/organization-profile-report.example.json) | You want one resolved organization profile and defaults. |
| `organization-profiles` | `knowledge/product/schemas/organization-profiles-report.schema.json` | [organization-profiles-report.example.json](../schemas/organization-profiles-report.example.json) | You want the full roster inventory and readiness summary. |
| `organization-catalogs` | `knowledge/product/schemas/organization-catalog-report.schema.json` | [organization-catalog-report.example.json](../schemas/organization-catalog-report.example.json) | You want the selected template overlays and role counts. |

## 1. Reports

### `organization-discovery`

- Command: `node dist/scripts/mission_controller.js organization-discovery`
- JSON variant: `node dist/scripts/mission_controller.js organization-discovery --json`
- Optional filters:
  - `--summary`
- Schema: `knowledge/product/schemas/organization-discovery-report.schema.json`
- Canonical example: `knowledge/product/schemas/organization-discovery-report.example.json`

Payload summary:

- `title`
- `summary`
- `documents[]`
- `examples[]`
- `common_questions[]`

### `organization-catalogs`

- Command: `node dist/scripts/mission_controller.js organization-catalogs`
- JSON variant: `node dist/scripts/mission_controller.js organization-catalogs --json`
- Optional filters:
  - `--selected-only`
  - `--summary`
- Schema: `knowledge/product/schemas/organization-catalog-report.schema.json`
- Canonical example: `knowledge/product/schemas/organization-catalog-report.example.json`

Payload summary:

- `requested`
- `resolved`
- `selected_catalog`
- `selected_only`
- `summary.total_count`
- `summary.selected_count`
- `summary.template_count`
- `summary.required_role_count`
- `summary.optional_role_count`
- `catalogs[]`

### `organization-profile`

- Command: `node dist/scripts/mission_controller.js organization-profile`
- JSON variant: `node dist/scripts/mission_controller.js organization-profile --json`
- Optional filters:
  - `--organization-id <ORG>`
  - `--summary`
- Schema: `knowledge/product/schemas/organization-profile-report.schema.json`
- Canonical example: `knowledge/product/schemas/organization-profile-report.example.json`

Payload summary:

- `requested`
- `resolved`
- `selected_catalog`
- `mission_default_template`
- `agent_profile`
- `team_default_template`
- `lifecycle`
- `max_parallel_missions`
- `llm_default`
- `template_catalogs`
- `selected_catalog_templates`
- `operating_principles`
- `profile`

### `organization-profiles`

- Command: `node dist/scripts/mission_controller.js organization-profiles`
- JSON variant: `node dist/scripts/mission_controller.js organization-profiles --json`
- Optional filters:
  - `--organization-id <ORG>`
  - `--active-only`
  - `--ready-only`
  - `--missing-only`
  - `--source <customer|public>`
  - `--summary`
- Schema: `knowledge/product/schemas/organization-profiles-report.schema.json`
- Canonical example: `knowledge/product/schemas/organization-profiles-report.example.json`

Payload summary:

- `requested`
- `resolved`
- `selected_organization_id`
- `active_only`
- `ready_only`
- `missing_only`
- `source_filter`
- `summary.total_count`
- `summary.ready_count`
- `summary.missing_count`
- `summary.customer_count`
- `summary.public_count`
- `summary.active_count`
- `profiles[]`

## 2. Operational Rule

- Use `organization-discovery` when you want the overview, entrypoints, and canonical examples.
- Use `organization-profiles` when you want to inventory available orgs.
- Use `organization-profile` when you want one resolved org's defaults.
- Use `organization-catalogs` when you want to inspect which team template
  overlays are selected for a resolved org.

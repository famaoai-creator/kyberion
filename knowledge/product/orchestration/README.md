---
title: Orchestration Index
category: Orchestration
tags: [orchestration, index, routing, discovery]
importance: 10
author: Ecosystem Architect
last_updated: 2026-06-01
---

# Orchestration Index

This directory contains the operator-facing orchestration playbooks,
protocols, catalogs, and indexes used by Kyberion.

## High-signal entry points

- [Organization Selection Guide](organization-selection-guide.md)
- [Organization Discovery Reports](organization-discovery-reports.md)
- [Organization Discovery](organization-discovery.md)
- [Intent Scenario Catalog](intent-scenario-catalog.md)
- [Supported Actuators](supported-actuators.md)
- [Voice Interface Protocol](voice-interface-protocol.md)
- [Mission Team Templates](mission-team-templates.json)

The organization discovery reports are the machine-readable contracts for
inventorying organization profiles and selected template catalogs.
Four canonical examples live under `knowledge/product/schemas/` alongside the
corresponding report schemas:

- [organization-discovery-report.example.json](../schemas/organization-discovery-report.example.json)
- [organization-profile-report.example.json](../schemas/organization-profile-report.example.json)
- [organization-profiles-report.example.json](../schemas/organization-profiles-report.example.json)
- [organization-catalog-report.example.json](../schemas/organization-catalog-report.example.json)

If you need to switch organization context first, open the selection guide.
If you need the inventory contracts, open the discovery reports.

## Discovery Flow

| If you need to... | Open this first | Then use this command |
| --- | --- | --- |
| Start from the shortest discovery entrypoint | [Organization Discovery](organization-discovery.md) | `organization-discovery` or `organization-discovery --json` |
| Switch organization context | [Organization Selection Guide](organization-selection-guide.md) | `organization-profile --organization-id <ORG> --summary` |
| Inspect readiness or missing profiles | [Organization Discovery Reports](organization-discovery-reports.md) | `organization-profiles --summary` or `organization-profiles --missing-only --summary` |
| Inspect selected team template overlays | [Organization Discovery Reports](organization-discovery-reports.md) | `organization-catalogs --selected-only --summary` |
| Wire another tool to JSON | [Organization Discovery Reports](organization-discovery-reports.md) | add `--json` to the same command |

## Organization Discovery

| Document | Purpose |
| --- | --- |
| [Organization Selection Guide](organization-selection-guide.md) | How to switch org context at the CLI boundary |
| [Organization Discovery Reports](organization-discovery-reports.md) | CLI command matrix and JSON contracts for org inventory |

## Organization CLI Quick Reference

| Command | Use When | Main Filters |
| --- | --- | --- |
| `organization-catalogs` | You want selected team template overlays | `--selected-only`, `--summary`, `--organization-id <ORG>` |
| `organization-profile` | You want one resolved org profile and defaults | `--organization-id <ORG>`, `--summary`, `--json` |
| `organization-profiles` | You want inventory and readiness across orgs | `--organization-id <ORG>`, `--active-only`, `--ready-only`, `--missing-only`, `--source <customer|public>`, `--summary`, `--json` |
| `organization-discovery` | You want a compact overview of the discovery entrypoints | `--summary`, `--json` |

## Organization Discovery Copy/Paste

| Goal | Text Summary | JSON Output |
| --- | --- | --- |
| Inspect discovery entrypoints | `node dist/scripts/mission_controller.js organization-discovery --summary` | `node dist/scripts/mission_controller.js organization-discovery --json --summary` |
| Inspect one resolved org profile | `node dist/scripts/mission_controller.js organization-profile --summary` | `node dist/scripts/mission_controller.js organization-profile --json --summary` |
| Inventory org readiness | `node dist/scripts/mission_controller.js organization-profiles --summary` | `node dist/scripts/mission_controller.js organization-profiles --json --summary` |
| Inspect selected template overlays | `node dist/scripts/mission_controller.js organization-catalogs --selected-only --summary` | `node dist/scripts/mission_controller.js organization-catalogs --json --selected-only --summary` |

## Common Questions

| Question | Best Text Command | Best JSON Command |
| --- | --- | --- |
| What organization is selected right now? | `organization-profile --summary` | `organization-profile --json --summary` |
| Which customer orgs are missing a profile? | `organization-profiles --missing-only --summary` | `organization-profiles --json --missing-only --summary` |
| Which team template overlays are active for this org? | `organization-catalogs --selected-only --summary` | `organization-catalogs --json --selected-only --summary` |
| Which organization profiles are ready to use? | `organization-profiles --ready-only --summary` | `organization-profiles --json --ready-only --summary` |

## Canonical Example Files

- [organization-discovery-report.example.json](../schemas/organization-discovery-report.example.json)
- [organization-profile-report.example.json](../schemas/organization-profile-report.example.json)
- [organization-profiles-report.example.json](../schemas/organization-profiles-report.example.json)
- [organization-catalog-report.example.json](../schemas/organization-catalog-report.example.json)

## Common Commands

- Inventory the organization roster:

  ```bash
  node dist/scripts/mission_controller.js organization-profiles --summary
  ```

- Inventory the organization roster as JSON:

  ```bash
  node dist/scripts/mission_controller.js organization-profiles --json --summary
  ```

- Inspect the currently selected organization profile:

  ```bash
  node dist/scripts/mission_controller.js organization-profile --summary
  ```

- Inspect the currently selected organization profile as JSON:

  ```bash
  node dist/scripts/mission_controller.js organization-profile --json --summary
  ```

- Inspect the selected team template overlay for the current organization:

  ```bash
  node dist/scripts/mission_controller.js organization-catalogs --selected-only --summary
  ```

- Inspect the selected team template overlay as JSON:

  ```bash
  node dist/scripts/mission_controller.js organization-catalogs --json --selected-only --summary
  ```

## Read this first for common operator work

1. [Organization Selection Guide](organization-selection-guide.md)
2. [Organization Discovery Reports](organization-discovery-reports.md)
3. [Supported Actuators](supported-actuators.md)
4. [Intent Scenario Catalog](intent-scenario-catalog.md)

## Inventory fragments

- `service-endpoints.json`
- `service-presets/`
- `service-provider-catalog.json`
- `global_actuator_index.json`
- `global_skill_index.json`
- `provider-capabilities.json`
- `specialist-catalog.json`
- `team-role-index.json`

## Notes

- These documents are operator-facing and intentionally declarative.
- Prefer the smallest relevant entry point before diving into a specific
  workflow playbook.

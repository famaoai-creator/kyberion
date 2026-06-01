---
title: Organization Discovery
category: Orchestration
tags: [orchestration, organization, cli, discovery]
importance: 6
author: Ecosystem Architect
last_updated: 2026-06-01
---

# Organization Discovery

`organization-discovery` is the shortest CLI entrypoint for the organization
selection and inventory flow.

Use it when you want a compact, operator-friendly overview before deciding
whether to open the selection guide, the discovery report index, or the
copy/paste command table.

## Reading Order

| Step | Open This | Why |
| --- | --- | --- |
| 1 | [Orchestration Index](README.md) | Get the shortest overview of the orchestration entrypoints. |
| 2 | [Organization Discovery](organization-discovery.md) | Use the dedicated CLI entrypoint to see the discovery overview. |
| 3 | [Organization Selection Guide](organization-selection-guide.md) | Switch org context or inspect the summary command paths. |
| 4 | [Organization Discovery Reports](organization-discovery-reports.md) | Read the JSON contracts and command matrix in detail. |

## Command

```bash
node dist/scripts/mission_controller.js organization-discovery
```

## JSON Command

```bash
node dist/scripts/mission_controller.js organization-discovery --json
```

## Compact Command

```bash
node dist/scripts/mission_controller.js organization-discovery --summary
```

## Compact JSON Command

```bash
node dist/scripts/mission_controller.js organization-discovery --json --summary
```

## JSON Schema

- [organization-discovery-report.schema.json](../schemas/organization-discovery-report.schema.json)

## JSON Examples

- [organization-discovery-report.example.json](../schemas/organization-discovery-report.example.json)
- [organization-profile-report.example.json](../schemas/organization-profile-report.example.json)
- [organization-profiles-report.example.json](../schemas/organization-profiles-report.example.json)
- [organization-catalog-report.example.json](../schemas/organization-catalog-report.example.json)

## JSON Reading Guide

- `documents` is the recommended reading order for the operator pages.
- `examples` is the four-file canonical set for validating the discovery report payloads, including the roster inventory example.
- `common_questions` maps a common operator question to the exact command to run.
- The JSON payload is intentionally compact so other tools can render their own
  copy/paste or navigation UI from the same contract.
- `--summary` is the shortest text-mode view; it prints the document and
  example pointers and skips the question list.

## What It Shows

- `Organization Selection Guide`
- `Organization Discovery Reports`
- `Organization Discovery Copy/Paste`
- the four canonical example files for the discovery reports
- the common questions and direct commands for organization discovery

## When To Use

- You want the quickest possible entrypoint for organization discovery.
- You want to see the operator documents before choosing a deeper page.
- You want to jump straight to the four canonical example files for the discovery reports.
- You want a lightweight command to copy into chat or notes.

## Related Documents

- [Orchestration Index](README.md)
- [Organization Selection Guide](organization-selection-guide.md)
- [Organization Discovery Reports](organization-discovery-reports.md)

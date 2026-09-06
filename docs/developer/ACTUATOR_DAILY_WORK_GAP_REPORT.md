---
title: Actuator Daily-Work Gap Report
tags: [actuators, daily-ops, gap-analysis, operator-ux]
last_updated: 2026-09-06
status: investigation
---

# Actuator Daily-Work Gap Report

Canonical investigation snapshot. **Operator-facing body (Japanese):**
[`ACTUATOR_DAILY_WORK_GAP_REPORT.ja.md`](./ACTUATOR_DAILY_WORK_GAP_REPORT.ja.md).

This is an evidence report, not a product contract. Identifiers and paths stay English.

## Executive summary

Desktop-assistant daily work (GitHub PR/issue/review, Slack, docs, email/calendar, browser/RPA, shell/files/secrets, knowledge, schedules/digests, meetings/voice) **can only be run efficiently through Kyberion actuators in patches**. The catalog is wide (32 manifest-backed actuators, 38 service presets), but the assistant-facing path is narrow.

| Finding                                                                                          | Evidence                                                                     |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Primary execution path is `domain:action` pipeline / ADF, not a generic assistant API            | `libs/core/actuator-sdk.ts`, `scripts/pipeline-execution-part-control.ts`    |
| MCP can discover actuators and run 8 allowlisted pipelines; it cannot run arbitrary actuator ops | `knowledge/product/governance/mcp-tool-catalog.json`                         |
| GitHub daily work is write-heavy and missing list/get/review capture ops                         | `knowledge/product/orchestration/service-presets/github.json` (10 ops)       |
| Slack has three layers (satellite / presence / service preset)                                   | `satellites/slack-bridge`, `presence-actuator`, `service-presets/slack.json` |
| `secret-actuator` is darwin/win32 only                                                           | `libs/actuators/secret-actuator/manifest.json`                               |
| Official probes in this Cloud Agent VM failed: no `dist/`, Node 22 vs `engines.node >=24`        | `pnpm capabilities` / `pnpm pipeline` → `MODULE_NOT_FOUND`                   |

**Bottom line:** Kyberion already has more _governed_ daily-work machinery than a desktop assistant uses (working memory, ingest, meetings, voice, Chronos, approvals). The assistant already has more _ad-hoc GitHub/review/file_ power than the actuator presets. The missing brush-up is glue: capture-complete SaaS presets, an assistant-callable capture API, and an operator path that works before a full `pnpm build`.

Prioritized recommendations (P0–P2) live in the Japanese report §7.

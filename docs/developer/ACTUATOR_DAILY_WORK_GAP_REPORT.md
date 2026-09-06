---
title: Actuator Daily-Work Gap Report
tags: [actuators, daily-ops, gap-analysis, operator-ux]
last_updated: 2026-09-06
status: p1-implemented
---

# Actuator Daily-Work Gap Report

Canonical investigation snapshot. **Operator-facing body (Japanese):**
[`ACTUATOR_DAILY_WORK_GAP_REPORT.ja.md`](./ACTUATOR_DAILY_WORK_GAP_REPORT.ja.md).

This is an evidence report, not a product contract. Identifiers and paths stay English.

## Executive summary

Desktop-assistant daily work (GitHub PR/issue/review, Slack, docs, email/calendar, browser/RPA, shell/files/secrets, knowledge, schedules/digests, meetings/voice) **can only be run efficiently through Kyberion actuators in patches**. The catalog is wide (32 manifest-backed actuators, 38 service presets), but the assistant-facing path is narrow.

| Finding                                                                                                                                | Evidence                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Primary execution path is `domain:action` pipeline / ADF, not a generic assistant API                                                  | `libs/core/actuator-sdk.ts`, `scripts/pipeline-execution-part-control.ts`    |
| MCP can discover actuators, run allowlisted pipelines (now includes `daily-routine`), and call capture-only `kyberion.service.capture` | `knowledge/product/governance/mcp-tool-catalog.json`                         |
| GitHub daily read/review capture plus write-gated review submit is on the REST preset (19 ops)                                         | `knowledge/product/orchestration/service-presets/github.json`                |
| Slack has three layers (satellite / presence / service preset)                                                                         | `satellites/slack-bridge`, `presence-actuator`, `service-presets/slack.json` |
| `secret-actuator` is darwin/win32 only                                                                                                 | `libs/actuators/secret-actuator/manifest.json`                               |
| Official probes in this Cloud Agent VM failed: no `dist/`, Node 22 vs `engines.node >=24`                                              | `pnpm capabilities` / `pnpm pipeline` → `MODULE_NOT_FOUND`                   |

**P0 implemented (2026-09-06):** GitHub list/get/review capture ops; MCP `kyberion.service.capture` + `daily-routine` allowlist; `pnpm capabilities` without `dist/`; Slack three-path doc.

**P1 implemented (2026-09-06):** GitHub review submit writes; `daily-github-inbox` template; email operator one-pager; `pnpm playground`; calendar template off `dist/` shell; `github-mcp` deprecated as an external-MCP example; actuators README redirect; doctor naming (`pnpm run doctor` / `pnpm kyberion:doctor`). P2 leftovers are in the Japanese report §7.

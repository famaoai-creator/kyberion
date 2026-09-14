---
title: MCP (Model Context Protocol) Integration Guide
category: Tech-stack
tags: [tech-stack, mcp, integration, guide, protocol]
importance: 5
author: Ecosystem Architect
last_updated: 2026-09-13
---

# MCP (Model Context Protocol) Integration Guide

## 1. Overview

Model Context Protocol (MCP) is an open standard that enables AI models to interact with external tools and data sources seamlessly. Kyberion exposes a **curated MCP facade** (`pnpm mcp:server` / `mcp-server-cowork`) — not a 1:1 dump of every actuator op as a tool.

Canonical relationship model (tools ↔ skills ↔ actuators, discover/act/govern bands):

→ [mcp-facade-model](../../product/architecture/mcp-facade-model.md)

Tool allowlist and bands live in `knowledge/product/governance/mcp-tool-catalog.json`. Connector expectations sync via `plugins/kyberion/connector.json`.

## 2. Core Concepts

| MCP primitive         | Kyberion mapping                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tools**             | Curated facade tools in three bands: discover / act / govern                                                                                       |
| **Resources**         | Transferable first-party `SKILL.md` at `kyberion://skill/{plugin}/{skill}`                                                                         |
| **Skills (transfer)** | `kyberion.skill.list` / `kyberion.skill.get` — guides for LLMs, not unrestricted executors                                                         |
| **Actuators**         | Discovered via `kyberion.capability.*`; executed via `service.*`, allowlisted pipelines, or bounded `kyberion.actuator.invoke` (default `dry_run`) |

## 3. Implementation Patterns

### Pattern A: Facade tools (preferred)

Clients call the allowlisted facade. Prefer `capability.search` → choose a path → `service.capture` / `pipeline.run` / `actuator.invoke` (dry_run first).

### Pattern B: Skill transfer (not tool sprawl)

Do **not** promote every plugin skill to an MCP tool. Expose skill bodies as Resources + `skill.list` / `skill.get` so the LLM can load operating guidance on demand.

### Pattern C: Tier visibility

1. **Personal Tier**: Never exported via MCP unless explicitly whitelisted.
2. **Confidential Tier**: Tenant-scoped; only when server-side scope allows.
3. **Public Tier**: Default MCP visibility.

### Pattern D: MCP Connector Wrapper

For high-demand public MCP servers, connector capabilities wrap MCP server execution with schema validation. Shared client logic lives in the shared-network MCP client engine.

## 4. Benefits

- **Governance**: Allowlists, caller roles, and approval gates stay on the facade.
- **Discoverability**: LLMs browse tools via `list_tools` and skills via Resources / `skill.list`.
- **Bounded actuation**: `actuator.invoke` is allowlist-only; live mode requires operator role.

## 5. Roadmap notes

Historical “export every capability as a tool” ideas are superseded by the curated facade. Extend the catalog + allowlists rather than generating unbounded tool surfaces.

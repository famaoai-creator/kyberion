---
name: kyberion
description: Use Kyberion governed mission control, pipelines, public knowledge search, skill transfer, bounded actuator invoke, approval workflows, audit verification, and Cowork delivery through its MCP facade.
---

# Kyberion

Kyberion is a governed operator system. Prefer its curated MCP facade and pipelines over ad-hoc filesystem or shell operations.

Facade model (discover / act / govern): `knowledge/product/architecture/mcp-facade-model.md`.

## Operating rules

- Run the baseline pipeline before substantive work.
- Use mission control for multi-step or cross-artifact work.
- Keep personal and confidential knowledge out of public outputs.
- Treat approval decisions as human-controlled effects.
- Verify the audit chain when reviewing governed mutations.
- Load transferable skills via `kyberion.skill.list` / `skill.get` (or Resources); do not invent unrestricted tools.
- Prefer `capability.search` then allowlisted `pipeline.run` / `service.capture` / `actuator.invoke` (`dry_run` first).

## Core MCP capabilities

### Discover

- `kyberion.capability.list` / `kyberion.capability.search`
- `kyberion.skill.list` / `kyberion.skill.get`
- `kyberion.knowledge.search` / `kyberion.scope.current` / `kyberion.knowledge.feedback`

### Act

- `kyberion.pipeline.list` / `kyberion.pipeline.run` / `kyberion.pipeline.job_status`
- `kyberion.service.capture` / `kyberion.service.actuate` (operator + approval)
- `kyberion.actuator.invoke` (allowlisted; default `dry_run`)

### Govern

- `kyberion.mission.create` / `status` / `journal`
- `kyberion.approval.list_pending` / `kyberion.approval.decide`
- `kyberion.audit.export` / `kyberion.audit.verify`
- `kyberion.surface.cowork.deliver` / `list`
- `kyberion.knowledge.cowork_sync`

For high-risk operations, present the pending request to the operator and wait for explicit approval before calling the decision tool.

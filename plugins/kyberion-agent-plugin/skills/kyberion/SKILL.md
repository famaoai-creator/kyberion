---
name: kyberion
description: Use Kyberion governed mission control, pipelines, public knowledge search, approval workflows, audit verification, and Cowork delivery through its MCP tools.
---

# Kyberion

Kyberion is a governed operator system. Prefer its MCP tools and pipelines over
ad-hoc filesystem or shell operations.

## Operating rules

- Run the baseline pipeline before substantive work.
- Use mission control for multi-step or cross-artifact work.
- Keep personal and confidential knowledge out of public outputs.
- Treat approval decisions as human-controlled effects.
- Verify the audit chain when reviewing governed mutations.

## Core MCP capabilities

- `kyberion.pipeline.list` and `kyberion.pipeline.run`
- `kyberion.mission.create`, `kyberion.mission.status`, and `kyberion.mission.journal`
- `kyberion.knowledge.search` and `kyberion.knowledge.cowork_sync`
- `kyberion.approval.list_pending` and `kyberion.approval.decide`
- `kyberion.audit.export` and `kyberion.audit.verify`
- `kyberion.surface.cowork.deliver` and `kyberion.surface.cowork.list`

For high-risk operations, present the pending request to the operator and
wait for explicit approval before calling the decision tool.

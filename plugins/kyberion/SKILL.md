---
name: kyberion
description: Kyberion sovereign operator system — governed mission control, pipeline execution, knowledge management, approval workflows, and bidirectional knowledge sync for enterprise operators (SBI group). Use when the operator needs to run Kyberion pipelines, create/track missions, search the knowledge base, manage approval gates, export audit trails, or sync knowledge between Cowork and Kyberion.
---

# Kyberion Skill

Kyberion is a sovereign operator AI system with governance, audit, and 3-tier knowledge isolation. This skill documents the **curated MCP facade** (`pnpm mcp:server`) for Cowork and other MCP clients.

Relationship model: discover / act / govern bands — see `knowledge/product/architecture/mcp-facade-model.md`.

## Band: Discover

- **kyberion.capability.list** / **kyberion.capability.search** — Browse actuator capabilities before acting.
- **kyberion.skill.list** / **kyberion.skill.get** — Transferable `SKILL.md` guides (also MCP Resources `kyberion://skill/{plugin}/{skill}`).
- **kyberion.knowledge.search** — Search the public knowledge base.
- **kyberion.scope.current** — Show the active MCP caller scope.
- **kyberion.knowledge.feedback** — Record human feedback on knowledge retrieval.

## Band: Act

- **kyberion.pipeline.list** / **kyberion.pipeline.run** / **kyberion.pipeline.job_status** — Allowlisted pipeline execution.
- **kyberion.service.capture** — Read-oriented service capture (preferred for Notion etc.).
- **kyberion.service.actuate** — Write-oriented service ops (**operator**, approval, usually disabled).
- **kyberion.actuator.invoke** — Bounded allowlisted actuator op; **default `dry_run`**; live needs operator.

  ```
  kyberion.actuator.invoke(actuator: "file-actuator", op: "pipeline", mode: "dry_run")
  ```

## Band: Govern

- **kyberion.mission.create** / **status** / **journal** — Mission control.
- **kyberion.approval.list_pending** / **kyberion.approval.decide** — Approval gate (`decide` is operator-only).
- **kyberion.audit.export** / **kyberion.audit.verify** — Audit chain.
- **kyberion.surface.cowork.deliver** / **list** — Cowork outbox.
- **kyberion.knowledge.cowork_sync** — Bidirectional Cowork ↔ Kyberion knowledge sync (public tier outbound).

## Governance Rules

1. **All tools are read-only or low-risk by default.** High-risk tools (`approval.decide`, live `actuator.invoke`, `service.actuate`) require operator confirmation / role.
2. **Tier isolation is enforced.** Only `public` tier content is accessible via MCP by default. Confidential/personal data never leaves Kyberion unless server-side scope allows.
3. **Pipeline and actuator execution are allowlisted.** Only entries in `mcp-tool-catalog.json` (`pipeline_run_allowlist` / `actuator_invoke_allowlist`) can run via MCP.
4. **Skills are guides, not tools.** Prefer Resources / `skill.get` over inventing new tools per skill.
5. **All operations are audit-logged.** Every MCP tool call that mutates state is recorded in the Kyberion audit chain.

## Quick Start

To check system health:

```
kyberion.pipeline.run(input: "pipelines/vital-check.json")
```

To search knowledge:

```
kyberion.knowledge.search(query: "how to onboard a new tenant", max_results: 5)
```

To sync knowledge from your Cowork work folder:

```
kyberion.knowledge.cowork_sync(direction: "cowork-to-kyberion", cowork_artifact_paths: ["outputs/meeting-notes.md"])
```

## Customer Customization

Enterprise deployments can extend this plugin via `customer/{slug}/plugin-overrides/kyberion.json` to:

- Expand `permissions.tier_visibility` to include specific `confidential/{project}` tiers
- Override `mcp_server.env` for tenant-specific personas
- Restrict or expand the tool list per deployment

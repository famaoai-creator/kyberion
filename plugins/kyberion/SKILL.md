---
name: kyberion
description: Kyberion sovereign operator system — governed mission control, pipeline execution, knowledge management, approval workflows, and bidirectional knowledge sync for enterprise operators (SBI group). Use when the operator needs to run Kyberion pipelines, create/track missions, search the knowledge base, manage approval gates, export audit trails, or sync knowledge between Cowork and Kyberion.
---

# Kyberion Skill

Kyberion is a sovereign operator AI system with governance, audit, and 3-tier knowledge isolation. This skill exposes its core capabilities as MCP tools accessible from Cowork.

## Available Capabilities

### Pipeline Execution
- **kyberion.pipeline.list** — List all available pipeline definitions in the Kyberion system.
- **kyberion.pipeline.run** — Execute a named pipeline by file path. Only pipelines on the explicit allowlist are permitted.

  ```
  kyberion.pipeline.run(input: "pipelines/vital-check.json")
  ```

### Mission Control
- **kyberion.mission.create** — Create a new Kyberion mission with a goal and context.
- **kyberion.mission.status** — Check the status of a running mission by ID.
- **kyberion.mission.journal** — Read the journal entries for a mission.

  Mission results are automatically delivered to the Cowork outbox via `kyberion.surface.cowork.deliver`.

### Knowledge
- **kyberion.knowledge.search** — Search the public knowledge base with a natural language query.
- **kyberion.knowledge.cowork_sync** — Bidirectional sync between Cowork artifacts and Kyberion knowledge. Respects 3-tier isolation: only `public` tier leaves Kyberion.

  ```
  kyberion.knowledge.cowork_sync(direction: "both", cowork_artifact_paths: ["outputs/summary.md"])
  ```

### Approval Gate
- **kyberion.approval.list_pending** — List all pending approval requests. Returns request IDs, severity, and summaries.
- **kyberion.approval.decide** — Apply an approved/rejected decision to a pending request. **High-risk — operator role required.**

  Workflow: `list_pending` → present via AskUserQuestion → `decide` with user's response.

### Audit Chain
- **kyberion.audit.export** — Export the append-only audit chain to a NDJSON file. Optionally filter by mission ID or date range.
- **kyberion.audit.verify** — Verify the integrity of the audit chain (SHA-256 hash-linked). Use for compliance checks.

### Surface Delivery
- **kyberion.surface.cowork.deliver** — Deliver a Kyberion artifact packet to the Cowork outbox. Used internally by mission completion hooks.
- **kyberion.surface.cowork.list** — List previously delivered artifacts in the Cowork outbox.

## Governance Rules

1. **All tools are read-only or low-risk by default.** High-risk tools (`approval.decide`) require explicit operator confirmation.
2. **Tier isolation is enforced.** Only `public` tier content is accessible via MCP. Confidential/personal data never leaves Kyberion.
3. **Pipeline execution is allowlisted.** Only pipelines in the `mcp-tool-catalog.json` allowlist can be run via MCP.
4. **All operations are audit-logged.** Every MCP tool call that mutates state is recorded in the Kyberion audit chain.

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

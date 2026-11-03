---
category: Added
---

- Add one API layer behind the surfaces. `libs/core/surface/surface-operation-registry.ts` declares the workspace operations (`workspace.summary`, `.list`, `.get`, `.search`) once and serves them both as HTTP `/api/v1/<domain>/<verb>` on Concierge and as MCP tools `kyberion.workspace.*`.
- The new workspace graph joins tenants, organizations, projects, missions (with tasks and staffing), work items, approvals, agents and members into one linked model, so every entity carries its tenant › organization › project › mission lineage and its actors. Rows are filtered by the caller's server-resolved viewer scope; a client-supplied tenant can only narrow it.
- The bundled MCP plugin configs (`plugins/kyberion-claude-code/.mcp.json`, `plugins/kyberion-agent-plugin/mcp.json`) now set `SYSTEM_ROLE` and `KYBERION_MCP_CALLER_ROLE`. Without them every governed MCP tool was refused with `MCP_CALLER_ROLE_REQUIRED`, so the plugins could not reach Kyberion.

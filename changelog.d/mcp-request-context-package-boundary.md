---
category: Changed
---

- Move the MCP request-context resolver from `@agent/core/mcp-request-context`
  into `@agent/shared-network`, where the MCP server engine and facade
  modules consume it. It is re-exported from the `@agent/shared-network`
  index alongside the Cowork cluster.
- Publish `@agent/core/contracts/nhi-id` so the resolver can still resolve
  claimed NHI identities; event scope and the governed environment registry
  remain public core services.
- Net export change in core is zero: one subpath removed, one added — cover
  the move in the existing CI workspace build contract without changing
  artifact scope.

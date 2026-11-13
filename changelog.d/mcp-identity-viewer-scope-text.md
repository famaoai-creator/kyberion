---
category: Fixed
---

- **Tenant activation probe: `viewer_scope` message** — the probe said `KYBERION_VIEWER_SCOPE=warn` only audits out-of-scope tenant reads and that `off` does not enforce. Every mode denies them; `warn` also records the attempt. The message now says so, and for `off` it says that `off` is not an accepted activation mode. The pass/fail result is unchanged (`off` still fails the probe). The activation approval refusal for `off` now reads "Viewer scope mode must be warn or enforce for activation".
- **MCP server lifecycle receipt** — the start/stop receipt of `mcp-server-cowork` now records the tenant the server serves requests for. It used to ignore `KYBERION_MCP_TENANT`, so a server bound with that variable wrote a system-scope receipt (or one for `KYBERION_TENANT`). Request handling is unchanged. A `KYBERION_MCP_TENANT` value that is not a valid tenant slug now stops the server at start with `[SCOPE_CONTEXT_INVALID]`; before, the server started and then refused every request with that error.
- **Company setup readiness summary** — the `viewer_scope` line in Concierge company setup no longer appends "(audit-only; access denial is not enforced)" when the mode is `warn`. That note was wrong: `warn` audits and then denies.

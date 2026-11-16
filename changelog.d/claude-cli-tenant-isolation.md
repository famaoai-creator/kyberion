---
category: Security
---

- **Isolated claude CLI under tenant credentials** — a claude CLI run bound to a tenant credential no longer reads the operator's settings, hooks, MCP servers, CLI extras or login. It runs with closed settings/MCP/hooks, in a tenant scratch directory, with the bound HOME / `CLAUDE_CONFIG_DIR` and only the credential matching the binding's kind (`api_key` adds `--bare`; `subscription_token` passes `CLAUDE_CODE_OAUTH_TOKEN`). A binding without the kind or its secret stops with `[CREDENTIAL_PROVIDER_DENIED]` before start. Operator (unbound) runs are unchanged. New doctor check `claude-tenant-isolation` (`pnpm doctor --manifest reasoning-backend`) confirms on the real CLI that an isolated, credential-free launch reports not logged in.

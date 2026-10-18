---
category: Added
---

- **Codex backend for peer conversation auto replies** — `pnpm peer:conversation-server --auto-reply-backend codex` generates replies through the new `runCodexIsolatedQuery` (`@agent/core/provider/codex-isolated-query`): `codex exec` with user config/rules/session persistence ignored, a read-only sandbox, approvals `never`, web search and MCP off and every tool-bearing feature disabled, in an empty scratch workspace with a minimal environment, under the same `peer_responder_reader` role and confidential `zero_retention` payload scope as the Claude backend. Tools stay visible to the model but cannot execute; any observed tool attempt discards the reply (`generation_failed` / `tool_attempt_detected`). Only isolation-tested codex-cli versions (`0.163`) run unless `--auto-reply-allow-untested` is passed. Default stays `claude`.

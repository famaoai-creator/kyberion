---
category: Changed
---

- Move the Cowork integration cluster — `cowork-surface`,
  `cowork-artifact-packet`, `cowork-knowledge-bridge`, and
  `cowork-health-check` — from `@agent/core` into `@agent/shared-network`,
  beside the MCP server engine that is its primary consumer. The
  `knowledge:cowork-sync` and baseline-check scripts now import these
  helpers via the `@agent/shared-network` index.
- Keep the governed approval adapter, artifact store, memory promotion
  queue, and scope plumbing in core — the Cowork modules still reach them
  through the public core subpaths, so outbox delivery and knowledge sync
  behaviour are unchanged.
- Remove eight core subpath exports (the four modules plus their `.js`
  aliases) and cover the move in the existing CI workspace build contract
  without changing artifact scope.

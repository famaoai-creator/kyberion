---
title: Codex CLI Multi-Account Profile Operations
tags: [codex, multi-account, authentication, operations]
last_updated: 2026-09-27
---

# Codex CLI Multi-Account Profile Operations

Codex stores ChatGPT login credentials, conversations, and settings below
`CODEX_HOME`. Kyberion exposes named profiles below `~/.codex-profiles/` so
personal and work accounts can run on the same host without sharing that
state. Host developer files and the repository remain outside the profile
directory and are inherited normally.

```bash
pnpm kyberion codex profile add work
pnpm kyberion codex profile login work
pnpm kyberion codex profile run work exec --help
pnpm kyberion codex profile list
pnpm kyberion codex profile delete work
```

`default` maps to the normal `CODEX_HOME` (or `~/.codex`). A named profile
sets `CODEX_HOME=~/.codex-profiles/<name>` for the child Codex process. The
same resolution is applied to Kyberion's Codex reasoning and app-server
adapters when `KYBERION_CODEX_PROFILE` is set. Treat each profile's
`auth.json` as a password and do not commit or share it.

---
category: Changed
---

- **Co-session coordination now enforces and delivers through provider hooks** — path-lease acquire/release is serialized through a shared inter-process lock, and hook-capable provider CLIs (Claude Code via tracked `.claude/settings.json`, Gemini via `pnpm generate:provider-hooks`) join the co-session automatically, receive pending handoffs in prompt context, get writes to foreign-leased paths denied, and release leases at session end. Hook-less CLIs use `scripts/co-session-monitor/poll.ts --provider <p> --participant-id <id>`.

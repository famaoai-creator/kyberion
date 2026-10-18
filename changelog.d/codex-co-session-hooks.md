---
category: Changed
---

- Codex CLI Co-Session hooks at session start, user input, tool completion, and session end, generated through `pnpm generate:provider-hooks` while preserving user hooks.
- Per-participant delivery receipts suppress repeated handoff injection without acknowledging requests.

- Claude Stop hooks emit no continuation instructions and skip recursive invocations, preventing review reminder loops.

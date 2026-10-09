---
category: Fixed
---

- **`pnpm check -- --scope pr` no longer times out on the role-assumption gate** — the reachability analyzer now runs in about half the time (~50s to ~27s alone) and its report is unchanged. The `role-assumption-reachability` gate also has its own 240s budget, so a busy concurrent run does not hit the 120s default.
- **Codex `light` wisdom profile timeout raised from 30s to 120s** — summarize/classify calls through `codex exec` were cut off once mission-llm began honouring `timeout_ms`, and a timeout fails the call instead of falling back to another profile.
- **Front-desk recovery engine integration test is stable on loaded hosts** — its budget now covers all the cold-started child processes it runs, and cleanup waits for those children to exit.

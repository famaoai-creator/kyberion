---
category: Added
---

- **Weekly system usage report.** `pnpm usage:weekly [-- --week YYYY-MM-DD] [--out <path>] [--json]` and the scheduled `pipelines/usage-weekly-report.json` (Monday 08:00 JST) summarize the previous Monday–Sunday week. The report includes week-over-week volume, session and mission counts, trigger failures, Dot denials, and LLM usage by execution origin. Audit counts require an explicit public system scope, so historical rows without scope are excluded. The output contains system totals without source identifiers and is written to `active/shared/runtime/reports/usage-weekly/usage-weekly-<week>.md` and a matching JSON file.
- **Long-session nudge.** The Claude Code `UserPromptSubmit` hook adds one hint suggesting a handoff note and `/clear` once a session reaches 150 prompts or 1,500 audited tool events, and repeats it every 25 prompts after that. It counts with a small per-session file under `active/shared/runtime/session-length/` (14-day retention) instead of scanning the audit chain, and a counter failure never fails the hook.

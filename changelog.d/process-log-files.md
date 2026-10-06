---
category: Changed
---

- **Logs no longer go to stdout, and every command keeps a log file.**
  - The `core.js` `logger` now writes info/success/debug lines to stderr, like warn/error and `createLogger`. Stdout carries only a command's own output (JSON, reports), so it stays parseable when piped or read by a parent process. If you piped a command's progress lines from stdout (for example `| grep`), redirect stderr instead (`2>&1 |`).
  - Every logger line is also written to `active/shared/logs/process/<entry>.log` (JSONL with `pid`, emitter and `mission`; rotated at 10 MB × 5), even when the console is quiet under `--json` or `--quiet`. Set `KYBERION_PROCESS_LOG=0` to turn it off.

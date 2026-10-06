---
category: Fixed
---

- **`pnpm mission list --json` and `pnpm pipeline --json` print machine-readable output.** Before, `mission list --json` ignored the flag and printed the table (or nothing at all when no missions matched), and `pipeline --json` printed nothing for a real run because `--json` only applied to `--dry-run`. `mission list --json` now prints a JSON array (`[]` when nothing matches). `pipeline --json` prints a run summary: `pipeline_id`, `status`, `run_id`, `trace_path`, per-step `op`/`status`/`error`, and `failure`. It never prints the pipeline context, which can hold tier-scoped data.
- **Running the test suite no longer leaves fake missions behind.** Two tests created `MSN-MAINTENANCE-RECORD-TASK` and `MSN-VISUAL-REVIEW-OP-TEST` in the live `active/missions/` tree and never removed them, so they showed up in `mission list` and mission hygiene. Both now clean up after themselves. If you ran the tests before, delete those two directories.

---
category: Added
---

- **Shadow mode for pull-request autonomy** — `pnpm kyberion pr shadow-observe` (or the opt-in `pr-shadow-observer` pipeline, every 30 minutes) records what the autonomy gate would do with each open PR — risk tier, CI, whether it would auto-merge — and settles PRs that were merged or closed. `pnpm kyberion pr shadow-report` compares that with what you actually did, per tier, and counts false positives (PRs the gate would have merged that you closed). Read-only toward GitHub: it never merges, comments or edits a PR. It needs the `gh` CLI authenticated on the host.

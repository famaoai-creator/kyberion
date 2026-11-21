---
category: Added
---

- **`pnpm kyberion create presence <displays|bridge>/<name>`** — scaffolds a presence workspace package and does its registration in one step: root and package tsconfig references, build-output layout, the CI dist caches in three workflows, the i18n scan root and the dependency graph. It plans every edit before writing, so a missing anchor changes nothing. It prints the steps that need a decision: lockfile install and its evidence, a root entrypoint, and docs.
- **`pnpm kyberion pr merge <pr>`** — waits for a PR's checks, then merges the head commit they passed on, through the governed `vcs:pr_merge` gate. It refuses on failure, timeout, zero checks, or a push that lands while CI runs. It needs your approval unless your charter delegates the merge.
- **`system:standard_pr_lifecycle` `auto_merge` now waits for CI.** It used to read the checks once, right after creating the PR, when they are always pending, so it refused every time. It now uses the same wait-then-merge verb (`vcsHostPrMergeWhenGreen`), with a new `checks_timeout_minutes` parameter.
- **Ratchet on PR gates that re-run PR-suite tests** — `scripts/test_suite.test.ts` fails when a pr-scope vitest gate lists a file the core or actuators suite already runs on every PR. The baseline is `scripts/check/test_suite_gate_duplicates.baseline.json`. Each such file ran twice; the 47-second CD-09 suite pushed `registration-tests` to its timeout.

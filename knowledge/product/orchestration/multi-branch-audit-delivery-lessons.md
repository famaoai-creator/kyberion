---
title: 'Multi-branch audit delivery lessons'
tags: [orchestration, ci, i18n, codeql, worktree, governance, lessons]
last_updated: 2026-10-01
source_mission: MSN-COHERENCE-AUDIT-20261001
knowledge_domain: product
runtime_stages: [execution, review]
---

# Multi-branch audit delivery lessons

Reusable lessons from delivering a 34-item repository-wide audit as four cascading PRs (CLI/docs, registries, i18n, orphan wiring), implemented by parallel subagents in separate worktrees.

## Verification

- **CI runs `pnpm check -- --scope full`, not `--scope pr`.** The pr scope missed a governance JSON without `$schema` (`catalogs`), a stale `actuator-op-discovery.json` after an op-catalog example edit (`op-registry`), and a vocabulary string that embedded a Playwright install step (`governance-rules`). Run the full scope before every push of a large change.
- **Localized assertions are environment-dependent.** After any change to locale resolution or to strings moved into `user-facing-vocabulary.json`, run the suite as CI does:
  `env -u KYBERION_LOCALE LANG=C.UTF-8 LC_ALL=C.UTF-8 CI=true ./node_modules/.bin/vitest run`.
  A Japanese-locale developer machine hides tests that assert Japanese replies without pinning a locale. Either the product path should derive the reply locale from the input, or the test must pin `KYBERION_LOCALE`.
- **CodeQL patterns that recur:** a `/x+$/` trailing trim is flagged as polynomial ReDoS; use a linear loop instead. A shell literal (`'sh'`, `'-c'`) in a test that reaches a generic spawn helper taints that sink for every caller. Test the exec policy in the secure-io suite with runtime-assembled names (`shellName(...)`).
- **PR state matters for CI.** A draft PR runs only CodeQL, and a conflicting PR runs nothing. Mark PRs ready, and merge `main` again before waiting on CI whenever `main` has moved.

## Multi-branch delivery

- **Cascade merges.** Merge in a fixed order: the first branch merges `main`, and each later branch merges its predecessor. Every PR then targets `main` with conflicts already resolved, and the later diffs shrink as the earlier PRs merge.
- **Retirements must win.** Git rename detection carries edits from another branch onto files that this branch moved to `retired/`. After each cascade merge, restore retired files to their retiring version.
- **Knowledge gate vs multi-PR missions.** `pnpm kyberion pr create` needs distilled candidates when a Mission ID is declared, but `distill` completes the mission and can only run once. Declare `Mission ID: N/A` (plus a "part n/m of MSN-…" note) on the earlier PRs, and the real ID only on the last one.
- **PR body files** must live inside the repository (`active/shared/tmp/<job>/`); secure-io refuses scratch paths outside the project root.

## Working with implementation subagents

- Give each agent an explicit file-ownership list and a "re-read before editing" rule for shared registries (vocabulary, `cli-commands.json`, env registry, barrels). Agents in the same worktree still collide on generated files, so regenerate rather than hand-merge.
- Expect lint-staged to block commits on unused imports that agents leave behind. Lint the changed files before committing.
- An independent reviewer per branch found real blocking defects every time: ACP over-denial from free-text matching, Japanese control words hijacking button utterances, scheduled pipelines writing tracked knowledge unattended, a misleading consent card, and ungoverned CLI writes. Then re-review the fixes before recording the review as passed.

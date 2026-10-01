---
title: 'Cross-worktree governance and path-policy lessons'
tags: [orchestration, worktree, secure-io, testing, git, governance, lessons]
last_updated: 2026-09-30
source_mission: MSN-KNOWLEDGE-IN-PR-20260930
knowledge_domain: product
runtime_stages: [execution, review]
---

# Cross-worktree governance and path-policy lessons

Reusable lessons from shipping mission learnings inside code PRs: secure-io confines I/O to the current root, an over-broad test-exclude glob had hidden 34 test files, git path output must be unquoted for policy checks, and gates on expected waits must fail closed without mutating state.

## When this applies

You build tooling that spans worktrees (mission ledger in the main checkout, code in a feature worktree) or that enforces path policies on a git diff.

## Lessons

1. **secure-io never reads or writes outside the current Kyberion root.** tier-guard rejects sibling-worktree paths with `[POLICY_VIOLATION] Path outside project root`, and there is no allowlist. To act on another worktree, run a child `node` process via `safeExecResult` with `KYBERION_ROOT=<target>` that imports the built `@agent/core` and does the I/O there, so the target's own secure-io, tier-guard and policy apply. Pass data over stdin, not argv, and have the child assert its root equals the target. Reference: `libs/core/knowledge/memory-promotion-git.ts` (`writePromotedFilesToWorktree`) and `libs/core/knowledge/pr-knowledge-readiness.ts`.
2. **Anchor test-exclude globs to the repository root.** `vitest.config.mts` used to exclude `**/knowledge/**` to skip the governed `knowledge/` data tree. That glob also matched the source directories `libs/core/knowledge/` and `libs/actuators/wisdom-actuator/src/knowledge/`, so 34 test files (330 tests) never ran, locally or in CI. It is now `knowledge/**`. When you add an exclude, check that it matches no source path: `git ls-files '*.test.ts' | grep <dir>`.
3. **Unquote git paths before checking them against a policy.** `git diff --name-only` C-quotes non-ASCII paths (a Japanese filename becomes `"knowledge/personal/\343..."`), so a `startsWith` check misses them. Use `git -c core.quotePath=false diff --name-status -z --no-renames --end-of-options <base>...HEAD`, split on NUL, and compare normalized, case-folded prefixes. Diff against `origin/<base>`, not a possibly stale local branch.
4. **Tier rules must allow the files the repo tracks on purpose.** `.gitignore` negations deliberately track some files under `knowledge/personal/` (README, voice config). Flag only files added to the tier (status `A`), not edits to files already tracked.
5. **A gate on an expected wait must not mutate state, and must fail closed.** Mission `finish` ratification (waiting for a PR to merge) runs before any gate that resets status or emits snapshots, so a blocked `finish` can simply be re-run. If the check itself throws, finish blocks rather than continuing.
6. **An independent review round pays off on governance gates.** The first review of this change found three must-fix bypasses (the quoted-path tier leak, the false positive that blocked every personal-voice PR, and a fail-open check) that 199 green tests did not catch.
7. **The mission checkout must run code that knows the new fields.** Schemas resolve from the Kyberion root (`pathResolver.rootResolve`), so a mission ledger in a checkout on an older branch rejects new candidate fields (`must NOT have additional properties`). When the mission checkout lags the PR branch, bring it up to date first. A worktree-local copy of the evidence and candidate does not work, because approval also checks the audit chain, which lives only in the mission checkout; forking it would break its integrity.

## Provenance

Curated from MSN-KNOWLEDGE-IN-PR-20260930, the mission that added the knowledge-in-PR flow. It was the first PR to ship its lessons this way, as a bootstrap: its own `memory-promote --target-root` could not run because of lesson 7, so this document was written by hand and the queue candidate was closed with `memory-reject`. The PR review is the steward review.

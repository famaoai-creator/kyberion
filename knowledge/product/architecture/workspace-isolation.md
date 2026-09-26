---
title: Workspace Isolation (Private Git Index, Session Worktrees, Ledger, Disk Budget)
category: Architecture
tags: [architecture, workspace, git, multi-provider, co-execution, storage, ws-01, ws-07]
importance: 8
author: Ecosystem Architect
last_updated: 2026-09-26
---

# Workspace Isolation

Several provider CLIs often share one checkout (see the
[multi-provider co-execution contract](../governance/multi-provider-coexecution-contract.md)
and [co-session coordination](./co-session-coordination.md)). The work-item
claim keeps them from writing the same files, but git state is global to the
checkout: one worker's `git add` lands in the index every other session sees.
The WS items bound that shared state and the disk that per-session copies use.

## WS-01 — Private git index per write-capable session

`libs/core/session-git-index.ts` — `prepareSessionGitIndex({ cwd, sessionId })`.

- Resolves the checkout with `git rev-parse --is-inside-work-tree`,
  `--show-toplevel` and `--git-path index` (the last one makes linked
  worktrees resolve to their own `.git/worktrees/<name>/index`).
- Seeds `active/shared/runtime/git-indexes/<sessionId>/index` with
  `git read-tree <HEAD>` (`--empty` without commits). It never copies the
  shared index: that may hold other sessions' staged work, which would then
  end up in this session's commit.
- Records `baselineSha` (HEAD at seeding; `null` in a repository without commits).
- Registers the **directory** in the workspace ledger as kind `git-index`
  before writing, after `checkWorkspaceBudget` allowed it, together with the
  registering process (`pid` + `pidStartedAt`, the `ps -o lstart=` start
  marker that guards against pid reuse) and a cached size (`bytes`).
- Returns `null` (and warns) instead of throwing when `cwd` is not in a work
  tree, the session id is not a safe path segment, the budget denies the copy,
  or seeding fails — the delegation then simply shares the real index.
- `attachChild(pid)` records the spawned child (`childPid`) in the ledger.
- `dispose({ childPid? })`:
  1. **Reconciles the shared index when HEAD moved.** Nothing stops a worker
     from committing with its private index (some CLIs do). HEAD then points
     at the worker commit while the shared index still holds the baseline
     tree, so the owner's next `git add x && git commit` would silently revert
     the worker commit. `reconcileSharedIndex` diffs the baseline against the
     new HEAD and moves each changed path's shared-index entry to HEAD's blob
     (`git update-index -z --index-info`) — only where the shared entry still
     equals the baseline, so work another session staged there is never
     clobbered (skipped paths are reported). Each reconciliation is logged as
     a warning and recorded in the audit chain (`shared_index_reconcile`).
  2. Releases the ledger entry.
  3. Deletes the directory — unless the child (or its process group) is still
     alive (e.g. the wall-clock timeout path disposes right after `SIGKILL`).
     Then the directory is kept with `childPid` recorded; a later `dispose`
     (on `close`) or the WS-07 sweep deletes it once the child is gone.
     It is idempotent. Anything a crashed process leaves behind is reclaimed by
     the WS-07 sweep.

## WS-02 — One spawn-env builder for every provider CLI

`libs/core/provider-spawn-env.ts` —
`buildDelegationSpawnEnv({ provider, cwd?, sessionId, profile? }) → { env, dispose }`.

- `env` = XP-02 `buildProviderChildEnv` (credential allowlist) + SA-05
  `childDelegationEnv()` (delegation depth + 1) + `GIT_INDEX_FILE` from WS-01.
- The private index is added **only** for the effective permission profile
  `implementer` and only while `KYBERION_SESSION_GIT_INDEX` is not `0`
  (default on; Vitest keeps it off unless a test sets `1`). The XP-02 allowlist
  drops every `GIT_*` variable, so an inherited `GIT_INDEX_FILE` never leaks;
  the injected one is not a credential.
- Every provider CLI delegation spawn uses it (claude batch/stream + session
  adapter, codex, gemini, cursor, opencode, devin, grok, agy CLI + SDK bridge).
  The backend passes the same effective profile it projects to argv; backends
  or spawns with no per-call profile (structured queries, the shared agy SDK
  bridge, cursor's `--worktree` native delegations) pass none and get no
  private index. Codex maps `mode: 'workspace-write'` without a profile to
  `implementer`.
- Backends spawn through `spawnWithDelegationEnv(spawnEnv, () => spawn(...))`:
  a synchronous spawn failure disposes the env and rethrows; otherwise the
  child's pid is attached and `disposeOnChildExit` disposes on `close` /
  `error`. The wall-clock-budget timeout paths dispose explicitly as well.

Limits and hazards:

- `GIT_INDEX_FILE` applies to every repository the child runs git in. A
  worker that enters another repository (e.g. a mission micro-repo) uses the
  same private index there — `git add`/`git commit` in that repository would
  write a tree built from _this_ checkout's index. Such work must use a
  session worktree (WS-03) instead.
- Grandchildren inherit the variable and may outlive the child. If the index
  file is deleted under them, git treats the index as empty and a
  `git commit` there would record a tree with every file deleted. Dispose
  therefore keeps the directory while the child pid or its process group is
  alive, and the sweep never deletes a git index whose `childPid` still runs.
  A grandchild that detached into its own process group is not detectable —
  delegated CLIs must not leave background git processes behind.
- A provider CLI that re-sanitises its own env loses the variable and falls
  back to the shared index.

## WS-03 — Commits stay with the mission owner

Workers must not commit (`.git` writes are mission-owner only), but nothing
enforces it; a worker commit is absorbed by the WS-01 dispose reconciliation.
The private index captures accidental staging. The owner may commit what a
session staged:

- `commitFromSessionIndex(idx, message)` (`libs/core/mission-git.ts`) refuses
  on a delegated path (`KYBERION_DELEGATION_DEPTH > 0`) or a non-owner role
  (`mission_controller` / `orchestrator` / `mission_owner`), and refuses when
  HEAD moved away from `baselineSha` — the index is a full tree snapshot, so a
  stale one would silently revert other sessions' commits. The commit is
  built with `git write-tree` + `git commit-tree` and HEAD advances with
  `git update-ref HEAD <new> <baseline>`, a compare-and-swap that fails
  (`[SESSION_INDEX_STALE]`) if HEAD moved between the check and the update.
  Commit hooks do not run on this path. After committing it refreshes the
  shared index for exactly the committed paths.
- `createSessionWorktree({ sessionId, repoRoot?, ref? })` creates an opt-in
  detached worktree under `.worktrees/<sessionId>` for parallel writers, owner
  path only, budget-checked and registered as `git-worktree` before
  `git worktree add`.

## WS-05 — Workspace ledger

`libs/core/workspace-ledger.ts`, `active/shared/runtime/workspaces/ledger.json`
(schema `knowledge/product/schemas/workspace-ledger.schema.json`, updates
under the shared lock). Kinds: `git-worktree`, `scratch-dir`, `git-index`.
The ledger is the only source of ownership: deletion goes through
`deleteRegisteredWorkspace`, which re-validates that the path is canonical,
symlink-free and under an allowed root (`active/shared/runtime/workspaces/`,
`.worktrees/`, `active/shared/runtime/git-indexes/`). Git worktrees are removed
with `git worktree remove --force` on the owner path, never `rm`. Callers that
decided on an earlier snapshot pass `guard.expect` (`live`, `createdAt`,
`releasedAt`); the delete re-checks it under the ledger lock and refuses
(`[WORKSPACE_CHANGED]`) when the record was re-registered or re-released in
between — re-registering a path reuses its id. `guard.requireCleanWorktree`
refuses (`[WORKSPACE_DIRTY]`) a git worktree with `git status --porcelain`
output or commits no branch, tag or remote reaches. Workspaces
never live under `active/shared/tmp/`, whose 24h TTL sweep would delete them
mid-use.

## WS-06 — Disk budget

`libs/core/workspace-budget.ts` — `checkWorkspaceBudget(targetDir, expectedBytes)`.
Policy `knowledge/product/governance/workspace-budget-policy.json` (cap
20 GiB, free-disk floor 2 GiB, orphan TTL 24h) with
`KYBERION_WORKSPACE_DISK_CAP_BYTES` / `KYBERION_WORKSPACE_MIN_FREE_BYTES` /
`KYBERION_WORKSPACE_ORPHAN_TTL_HOURS` overrides. Usage is summed from each
record's cached `bytes` (set at register / release, refreshed by the sweep);
only records without one are measured, with a walk bounded by entry count
and wall time. Near the cap it reclaims released workspaces oldest first,
skipping any that fail to delete (vanished, changed, owner-only) instead of
aborting the check. Git worktrees are never reclaimed inline — they wait for
the sweep's TTL and unsaved-work check. An unreadable free-space probe fails
closed when a floor is configured.

## WS-07 — Janitor sweep and CLI

The storage janitor calls `sweepWorkspaces` (`libs/core/workspace-sweep.ts`).
Orphans are:

- released entries past the TTL;
- live entries whose owning mission is terminal and older than the TTL;
- live `git-index` entries whose registering process is gone (pid dead, or
  alive with a different start marker); legacy entries without a pid fall
  back to the TTL on `createdAt`.

A `git-index` whose `childPid` is still alive is never an orphan. Orphans are
deleted through the ledger with the snapshot guard and the clean-worktree
check; surviving entries get their cached `bytes` refreshed. Unregistered
directories under the roots are reported, never deleted.
`pnpm kyberion workspace list [--json]` and
`pnpm kyberion workspace gc [--apply]` (dry run by default) expose the same.

## Related

- [Multi-provider co-execution contract](../governance/multi-provider-coexecution-contract.md)
- [Co-session coordination](./co-session-coordination.md)

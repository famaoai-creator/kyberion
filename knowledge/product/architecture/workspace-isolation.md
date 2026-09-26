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
- Seeds `active/shared/runtime/git-indexes/<sessionId>/index` by copying the
  real index (keeps its stat cache). When the real index is outside the
  secure-io scope (a linked worktree of another checkout) it falls back to
  `git read-tree <HEAD>`.
- Records `baselineSha` (HEAD at seeding; `null` in a repository without commits).
- Registers the **directory** in the workspace ledger as kind `git-index`
  before writing, after `checkWorkspaceBudget` allowed it.
- Returns `null` (and warns) instead of throwing when `cwd` is not in a work
  tree, the session id is not a safe path segment, the budget denies the copy,
  or seeding fails — the delegation then simply shares the real index.
- `dispose()` releases the ledger entry and deletes the directory; it is
  idempotent. Anything a crashed process leaves behind is reclaimed by the
  WS-07 sweep.

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
- `disposeOnChildExit(child, spawnEnv)` disposes on `close` / `error`; the
  wall-clock-budget timeout paths dispose explicitly as well.

Limits: `GIT_INDEX_FILE` applies to every repository the child runs git in.
A worker that enters another repository (e.g. a mission micro-repo) would use
the same private index there; such work should use a session worktree
(WS-03) instead. A provider CLI that re-sanitises its own env loses the
variable and falls back to the shared index.

## WS-03 — Commits stay with the mission owner

Workers never commit (`.git` writes are mission-owner only). The private
index only captures accidental staging. The owner may commit what a session
staged:

- `commitFromSessionIndex(idx, message)` (`libs/core/mission-git.ts`) refuses
  on a delegated path (`KYBERION_DELEGATION_DEPTH > 0`) or a non-owner role
  (`mission_controller` / `orchestrator` / `mission_owner`), and refuses when
  HEAD moved away from `baselineSha` — the index is a full tree snapshot, so a
  stale one would silently revert other sessions' commits. After committing
  it refreshes the shared index for exactly the committed paths.
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
with `git worktree remove --force` on the owner path, never `rm`. Workspaces
never live under `active/shared/tmp/`, whose 24h TTL sweep would delete them
mid-use.

## WS-06 — Disk budget

`libs/core/workspace-budget.ts` — `checkWorkspaceBudget(targetDir, expectedBytes)`.
Policy `knowledge/product/governance/workspace-budget-policy.json` (cap
20 GiB, free-disk floor 2 GiB, orphan TTL 24h) with
`KYBERION_WORKSPACE_DISK_CAP_BYTES` / `KYBERION_WORKSPACE_MIN_FREE_BYTES` /
`KYBERION_WORKSPACE_ORPHAN_TTL_HOURS` overrides. Near the cap it reclaims
released workspaces oldest first; an unreadable free-space probe fails closed
when a floor is configured.

## WS-07 — Janitor sweep and CLI

The storage janitor calls `sweepWorkspaces` (`libs/core/workspace-sweep.ts`):
released entries past the TTL, and live entries whose owning mission is
terminal and older than the TTL, are deleted through the ledger. Unregistered
directories under the roots are reported, never deleted.
`pnpm kyberion workspace list [--json]` and
`pnpm kyberion workspace gc [--apply]` (dry run by default) expose the same.

## Related

- [Multi-provider co-execution contract](../governance/multi-provider-coexecution-contract.md)
- [Co-session coordination](./co-session-coordination.md)

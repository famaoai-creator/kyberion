---
title: Multi-Provider Co-Execution Contract
category: Governance
tags: [governance, multi-provider, cli, co-execution, xp-04]
importance: 9
last_updated: 2026-07-25
---

# Multi-Provider Co-Execution Contract

Multiple provider CLIs (`claude`, `codex`, `agy`, and future adapters such as
`gemini` / `copilot`) can run against the same repository checkout at the
same time. Each treats its startup working directory as implicit context and
reads the same instruction file (`AGENTS.md`, projected via the `CLAUDE.md` /
`CODEX.md` / `GEMINI.md` symlinks). Without an explicit contract for who may
read, write, and touch Git, concurrent providers can race on the same files
or silently escalate a worker into a Git-writing role. This document is the
canonical read/write matrix referenced from `AGENTS.md` §1 Invariants and
projected into provider-specific instruction surfaces (see
[CT-01](../../../docs/developer/improvement-plans-2026-07/CLI_SUBAGENT_TEAM_PLAN_2026-07-25.ja.md)'s
generation ceremony). It formalizes §2 hard constraint 1 of
[XP-04](../../../docs/developer/improvement-plans-2026-07/CROSS_PROVIDER_EXECUTION_PLAN_2026-07-25.ja.md).

## Startup cwd contract

Every provider CLI must be launched with its working directory set to the
**repository root**, or — when operating inside a mission — the **mission
worktree root**. No provider may assume, chdir into, or be launched from an
arbitrary subdirectory as its operating context; doing so breaks the
instruction-file discovery chain (`AGENTS.md` and its symlinks) and makes the
read/write matrix below unenforceable, since claim and ownership checks are
scoped to that root.

## The read/write matrix

| Surface                                                                       | Who may act                                                                         | Why                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read (any repo file)                                                          | All providers, in parallel, unrestricted                                            | Reads never race and never mutate state, so gating them would only add latency without a safety benefit.                                                                                                                                                                                                                                                                              |
| Write (repo files)                                                            | The holder of the active work-item claim only                                       | Two providers writing the same file concurrently silently corrupts output; the claim is the single source of truth for who owns the pen.                                                                                                                                                                                                                                              |
| `.git/` and repo config (`.gitignore`, `package.json` workspace wiring, etc.) | Mission owner only — never a worker CLI                                             | Git history and repo-wide config are mission-scoped state; a worker committing or reconfiguring on its own defeats the one-owner-per-mission invariant and can silently rewrite shared history.                                                                                                                                                                                       |
| Temp files                                                                    | Any provider, but only under `active/shared/tmp/` (or mission-local storage)        | Ad hoc temp locations are invisible to cleanup and review, and can collide across concurrent providers; a single shared temp root keeps them inspectable and disposable.                                                                                                                                                                                                              |
| Provider state directories (`.claude/`, `.codex/`, `.agy/`, `.gemini/`, …)    | Nobody hand-edits them; they are gitignored and reproduced by generation ceremonies | Per-provider state is derivable from the SSoT (team-roles + KD-05 profiles + working principles); committing hand-edited copies would let providers drift from the canonical role/tool definitions. Exception: `.claude/agents/` is generated **and tracked**, guarded by CT-01's drift check, so reviewers can see subagent definitions in diffs without anyone hand-authoring them. |

## Enforcement notes

- Write access is enforced through the work-item claim mechanism, not the
  provider's own permission system — a provider's local sandboxing is a
  defense-in-depth layer, not the source of truth.
- Worker-profile delegations (see KD-05 capability tiers and the XP-02
  provider permission-profile mapping) must not grant `.git` write /
  commit / push tools; only the mission owner's execution path may perform
  Git writes.
- Provider state directories that are gitignored but not yet regenerable by
  a ceremony (e.g. a newly adopted provider) must still be excluded from Git
  rather than committed ad hoc — add the ignore rule first, wire the
  generation ceremony as a follow-up.

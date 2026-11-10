---
title: 'Delegation CLI Playbook — bounded governed delegation from the operator surface'
tags: [orchestration, delegation, cli, subagent, playbook]
last_updated: 2026-11-08
runtime_stages: [execution]
---

# Delegation CLI Playbook

`pnpm delegate` / `pnpm kyberion delegate` hands a bounded task to a governed
sub-agent through the same dispatch path as the in-session `invoke_agent` tool —
capability tiering (KD-05), depth policy, concurrency and wall-clock budgets,
audit records and observability all stay on. The CLI is an _entry point_, not a
new authority path.

## Usage

```
pnpm delegate "Summarize the auth boundary in libs/core" --profile explorer
pnpm delegate --task-file active/shared/tmp/brief.md --mission MSN-XXX-20261108 --json
```

- `--profile <tier>` selects a KD-05 capability profile
  (`implementer` default, `explorer`, `planner`; the registry in
  `libs/core/subagent-capability-profiles.ts` is the source of truth). An
  unknown value is rejected before dispatch — nothing runs under a mistyped
  tier.
- `--mission <id>` attributes the delegation trace to a mission so evidence and
  observability land on the right ledger.
- `--task-file` / `--context-file` read instruction and context from repo-local
  files — preferred for anything longer than a sentence.
- `--json` prints `{status, delegation_id, profile, result}` for scripting.

## Bounded by default

A delegated sub-agent runs at the caller's delegation depth plus one (policy
ceiling: three hops), under the concurrency governor and the inactivity timeout
(`--inactivity-timeout-ms`). A sub-agent cannot widen its own scope, mint
`goal:*` operations, or outrun its budget.

## Authorization: delegate once, approve once

The bottleneck this CLI removes is _dispatch_, not _judgment_. External effects
still need their own authority — the delegation itself does not grant it:

- **Standing authority for repeated work**: pre-authorize a scope through a dot
  charter (`pnpm kyberion dot create`, then `pnpm kyberion dot activate`) or a standing grant rather than
  approving each run. When the charter covers the effect, the delegated agent
  executes inside that scope without a fresh per-run approval; when it does not,
  the normal typed, snapshot-bound approval path applies and the delegation
  reports it is blocked rather than failing silently.
- **PR creation** (`vcs:pr_create`) is an external mutation: it runs through
  `withRuntimeExternalOperationAuthority` and needs an exact charter/grant or a
  fresh approval — the CLI never bypasses it.
- **Never-auto categories** (`secret_mutation`, `external_publish`,
  `cross_tenant`, `lower_tier_write`, `policy_change`, `dependency_major`) stay
  human-gated regardless of how the delegation was launched.
- High-risk paths (`AGENTS.md`, governance catalogs/schemas, `.github/**`,
  package/lock/workspace config, approval/auth code) keep their elevated score
  in `autonomous-ops-policy.json`; delegating the edit does not lower it.

In short: use `--profile` to bound _capability_, charters/grants to pre-bind
_authority_, and the mission flag to keep _attribution_ — the three are
independent controls and none substitutes for the others.

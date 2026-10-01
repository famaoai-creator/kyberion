---
title: 'Mission Triage Playbook — closing missions that cannot finish'
tags: [governance, lifecycle, maintenance, approval, triage]
last_updated: 2026-09-27
runtime_stages: [execution, review]
---

# Mission Triage Playbook

How to maintain missions that stall before `finish` — the intent-drift gate, unfinished
exit-gate tasks, lost evidence, or a deleted worktree. The design principle: **the agent
diagnoses and prepares; the human only approves**. Nobody needs `KYBERION_PERSONA`,
`MISSION_ROLE`, or `KYBERION_SUDO` on the command line for the standard path.

## Detect

```
pnpm mission hygiene [--notify]     # stale/abandoned population with recommendations
pnpm kyberion doctor                          # includes the hygiene report
pnpm mission purge                   # dry-run sweep preview (archive candidates by policy)
```

## Diagnose

```
pnpm mission triage <MISSION_ID>            # human-readable
pnpm mission triage <MISSION_ID> --json     # agent-consumable report
```

Classifications and the printed commands:

| classification         | meaning                                         | recommended action                                                   |
| ---------------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| `intent_drift_blocked` | delivered scope diverged from the origin intent | `scope_rebaseline` (approval-mediated `scope-approve`) or `abandon`  |
| `unfinished_tasks`     | pending `NEXT_TASKS` block the exit gate        | close tasks via `record-evidence`, or `reconcile-work`, or `abandon` |
| `awaiting_finish`      | validating/distilling, nothing pending          | `verify → distill → finish` / `finish`                               |
| `ready_to_verify`      | active, all tasks closed                        | `verify → distill → finish`                                          |
| `in_progress`          | active with pending tasks                       | keep working; `record-evidence` per task                             |
| `not_started`          | planned, never activated                        | `start` or `abandon`                                                 |
| `terminal`             | completed/failed but still under `active/`      | `archive --mission <ID> --execute`                                   |
| `not_found`            | no mission directory (e.g. deleted worktree)    | nothing to close — record the outcome in the project ledger          |

## Resolve: approval-mediated scope rebaseline (no SUDO)

`scope-approve` rewrites the origin intent baseline, so the direct path requires SUDO.
The approval path substitutes an authenticated human decision — the same trust shape as
`reconcile-work` (PI-05):

```
# agent files the request (state is not mutated):
pnpm mission triage <ID> --request-approval [--goal "<as-delivered goal>"] [--reason "..."]
# or directly:
pnpm mission scope-approve <ID> --request-approval --goal "<goal>" --reason "<reason>"

# human reviews exactly what changes and decides:
pnpm kyberion approvals                        # details render inline
pnpm kyberion approvals --approve <request-id> # or --deny <id> --note "..."

# agent applies (fails closed if goal/reason differ from what was approved):
pnpm mission scope-approve <ID> --approval-request-id <request-id> --goal "<same>" --reason "<same>"
pnpm mission verify <ID> verified "<note>" && pnpm mission distill <ID> && pnpm mission finish <ID>
```

The request's `details` show: mission id, current origin goal, proposed goal, proposed
success condition, reason, drift-gate verdict, requester, and the effect of approval.
`payloadHash` binds apply to that exact text — editing it after approval is rejected.
The human decider is recorded as `approved_by` in `context.approved_scope_change` and a
`SCOPE_APPROVED` history entry.

The SUDO direct path (`KYBERION_SUDO=true pnpm mission scope-approve ...`) still exists
for the sovereign operator; workers should prefer the approval path.

## Resolve: abandon

For missions whose evidence is already gone or whose work is superseded:

```
pnpm mission cancel <ID> --note "<why>"
pnpm mission archive --mission <ID> --execute     # status must be completed|failed
```

`cancel` sets `status=failed` (which makes the mission archivable) and records
`context.cancelled`/`cancel_reason`. `archive` moves the tree under
`active/archive/{missions,failed_missions}/` per the lifecycle ADF policy, writes the
`mission-purge.jsonl` audit record, and reclaims runtime residue and mission identities.
`purge --execute` sweeps policy-matched missions (e.g. failed + aged) in bulk.

## Resolve: nothing left

If the mission directory is gone (worktree deleted before close), the ledger went with
it — `triage` reports `not_found`. There is nothing to archive. If the delivered work
landed elsewhere (merged PR), note the outcome in the linked project ledger
(`04_control/mission-ledger.md`) so the audit trail acknowledges the unclosed mission.

## Prevention

- **Close before cleaning.** Never delete a worktree while a mission it hosts is
  non-terminal — the mission ledger lives in that checkout's gitignored `active/`.
- **Run mission_controller from the main checkout.** Evidence and state then survive
  worktree lifecycle.
- **Record evidence as work happens**, per `phases/execution.md` — retroactive
  `reconcile-work` needs an authenticated human approval and is deliberately strict.
- Surface drift early: `pnpm mission triage <ID>` before assuming `finish` will pass.

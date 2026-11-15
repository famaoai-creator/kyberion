---
title: 'Mission Triage Playbook — closing missions that cannot finish'
tags: [governance, lifecycle, maintenance, approval, triage]
last_updated: 2026-11-15
runtime_stages: [execution, review]
---

# Mission Triage Playbook

How to maintain missions that stall before `finish` — the intent-drift gate, unfinished
exit-gate tasks, lost evidence, or a deleted worktree. The design principle: **the agent
diagnoses and prepares; the human only approves**. Nobody needs `KYBERION_BASE_ROLE`,
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

## Resolve: unfinished tasks left by direct work

The common shape: work happened in a worktree / subagent / another PR and `NEXT_TASKS`
never got closed, so the exit gate reports pending tasks on an otherwise finished
mission. `checkpoint` and `record-evidence` only append ledger entries — a task closes
when its own rule fires:

- The task's declared `deliverable` file must exist at its declared path, inside the
  mission's evidence tree — a note referencing it is not enough.
- `record-evidence <ID> <task> "<note>" --actor-id <who did it>` closes a normal task
  once that deliverable exists **and** every listed dependency is already completed —
  completions cascade, so record in dependency order.
- Review-kind tasks never close from `record-evidence`: an independent reviewer records
  `review-task <ID> <review_task> <reviewer>` (independence is read from the execution
  ledger, not declared). One valid receipt per review task.
- A completed task list on an `active` mission means `verify` → `distill` → `finish`;
  a failed `finish` leaves the mission `active`, so re-run the whole tail after fixing
  the gate.
- `reconcile-work` is for genuinely external work: commit-bound manifest evidence plus
  an authenticated human approval (PI-05). It additionally requires a **task credential
  binding** — see below — so it cannot run from a bare terminal claim.

## Personal-tier missions: the constrained path

Two extra limits apply only to `--tier personal` missions (`knowledge/personal/missions/`):

- **Evidence placement is process-gated.** The tier guard restricts
  `knowledge/personal/` writes to authorized personal processes — ordinary agent file
  tools and ad-hoc shell writes are denied regardless of who asks. Either the installed
  personal runtime places the deliverables, or the mission adopts external work via
  `reconcile-work` (which never writes `knowledge/personal/` itself).
- **Dispatch cannot route it.** `dispatch-workitems` needs `tenant_slug` for project
  recovery (`[MISSION_WORKITEM_SCOPE_REQUIRED]`) and personal missions have none.
  The only designed way a personal mission gains a task credential binding is the
  **installed personal runtime** claiming and executing the mission's WorkItem through
  the agent execution port — `assertPersonalTaskCredentialClaim` checks a minted scope
  envelope, a `claim`-provenance agent actor matching the installed runtime's NHI, and a
  live attempt + lease attributed to that agent. A `work claim-item` lease from an
  operator CLI is coordination only; it mints no binding.

So for a personal mission stalled on pending tasks, the order of operations is:
personal runtime executes the claimed WorkItem (binding minted) → `reconcile-work
--request-approval` files the `mission_gate` request → human approves
(`pnpm kyberion approvals --approve`, A2+) → apply with `--approval-request-id` →
`verify` → `distill` → `finish`. If the runtime path is unavailable, the human places
evidence via an authorized personal process and the standard `record-evidence` flow
closes the tasks instead.

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

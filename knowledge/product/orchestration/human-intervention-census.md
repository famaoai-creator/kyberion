---
title: Human Intervention Census — measuring where a human is still needed
category: Orchestration
tags: [orchestration, autonomy, approval, census, decision-rights, metrics]
importance: 7
author: Ecosystem Architect
last_updated: 2026-09-28
---

# Human Intervention Census

Use `scripts/report_human_interventions.ts` before changing decision rights or autonomy levels. It counts, per category, how often a human decided, how often an agent decided, and what is still waiting.

```bash
node dist/scripts/report_human_interventions.js --since 2026-08-28 [--json] [--main-ref origin/main]
```

## Where human decisions actually live

The approval store is not the only record, and today it is not the main one:

- **PR merges live in git.** `main` first-parent merge commits (`Merge pull request #N`) and squash subjects (`(#N)`). The merge commit author is whoever clicked merge, so an agent merging with the operator's token looks human; squash merges are unattributed.
- **Conflicts live in git.** Sync merges of `main` into a branch are replayed with `git merge-tree --write-tree` (exit 1 = conflict). Who resolved the conflict is not recorded anywhere.
- **Silent waits live in mission state.** `planned` and `paused` missions are waits on a human that nobody is notified about. They are a snapshot, not a windowed count.

## Traps in the approval store (2026-09)

- **Test pollution.** Until 2026-09-27, test suites wrote into the production store. Since then, `approvalStoreRoots()` sends vitest runs to `active/shared/runtime/vitest-approvals/`. Any code that builds approval paths must call `approvalRequestLogicalPath` / `approvalEventLogicalPath` rather than hard-coding `coordination/channels/<ch>/approvals`. Old leftovers are matched by `isFixtureApproval` in `libs/core/approval-store-hygiene.ts`; the census and the cleanup share these rules. The rules match on:
  - the token `test` or `fixture` (as a whole word) in the channel, requester, or decider;
  - channels starting with `qm<N>-`;
  - decider `U123` and requester `human:alice`;
  - throwaway plugin titles;
  - the exact reason values of `secret-introduction.test.ts`.

  The records live on a plain `terminal` channel with requester `operator`, so only the reason value identifies them. When a new leak is found, add its signature to `isFixtureApproval`, not to the census alone.

- **Cleaning up.** Run `node dist/scripts/approval_store_hygiene.js`. It is a dry run by default. It counts records by channel and by matched rule; `--json` lists every record with its title, requester and matched rule — check them before applying. `--apply` moves fixture request records to `active/archive/.trash/`, where they can be restored for 30 days (the audit line records the matched rule). Their lines in the `approvals.jsonl` event logs stay as history. It also expires stale pending requests. Requests owned by a suspended pipeline are skipped, because the pipeline's own timeout decides for them. An expired request can no longer be decided, and a gate with no expiry re-requests instead of blocking. Only the sovereign persona may write the trash, so run `KYBERION_PERSONA=sovereign node dist/scripts/approval_store_hygiene.js --apply`. Without it the script stops before changing anything and prints that command.
- **Auto-approvals stamped human.** Before 2026-09-27, policy auto-approvals of secrets carried `decidedByType: human`. For those records, only the workflow note `Auto-approved …` shows that no human acted. New ones use `decidedBy: policy:…` and `decidedByType: service`. Count a record as agent only when every decided workflow entry is auto-approved.
- **Missing decider type is not agent.** Legacy decisions lack `decidedByType`; count them as unattributed, never as agent, or the census flatters autonomy.
- **Pending requests used to never expire.** Secret requests now expire 24 hours after creation. The hygiene sweep also expires pending requests past `expiresAt`, and those with no expiry that are older than 14 days (`reason: stale_pending` on the event). Until the sweep runs on a schedule, orphaned requests still inflate "waiting on human" between runs.

## Using the numbers

- Rank autonomy work by human load: in 2026-09 PR merges dominated (92 in 30 days, all manual), conflicts were rare (2 of 22 syncs).
- Do not enable an autonomous tier from census numbers alone. The census shows volume, not risk or revert rate; run the tier in shadow mode first and compare with the operator's actual decisions.

Plan and decision-rights matrix: `docs/developer/improvement-plans-2026-09/AUTONOMOUS_OPERATION_MOBILE_DECISION_PLAN_2026-09-27.ja.md`.

---
title: Human Intervention Census — measuring where a human is still needed
category: Orchestration
tags: [orchestration, autonomy, approval, census, decision-rights, metrics]
importance: 7
author: Ecosystem Architect
last_updated: 2026-09-27
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

- **Test pollution.** Suites write into the production store. Exclude by token-anchored `test`/`fixture` in channel, requester, or decider; `qm<N>-` channels; decider `U123` (placeholder Slack user); `human:alice`; plugin titles shaped `<label>-<pid>-<uuid8>` or `<label>-<5–6 digit pid>`. In the 2026-09-27 run, 3,351 records were fixtures, over 95% of the store.
- **Auto-approvals stamped human.** Policy auto-approvals carry `decidedByType: human`; only the workflow note `Auto-approved …` shows no human acted. Count a record as agent only when every decided workflow entry is auto-approved.
- **Missing decider type is not agent.** Legacy decisions lack `decidedByType`; count them as unattributed, never as agent, or the census flatters autonomy.
- **Pending requests never expire.** Orphaned `pending` requests accumulate and inflate "waiting on human".

## Using the numbers

- Rank autonomy work by human load: in 2026-09 PR merges dominated (92 in 30 days, all manual), conflicts were rare (2 of 22 syncs).
- Do not enable an autonomous tier from census numbers alone. The census shows volume, not risk or revert rate; run the tier in shadow mode first and compare with the operator's actual decisions.

Plan and decision-rights matrix: `docs/developer/improvement-plans-2026-09/AUTONOMOUS_OPERATION_MOBILE_DECISION_PLAN_2026-09-27.ja.md`.

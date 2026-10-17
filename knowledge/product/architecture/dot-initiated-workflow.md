---
title: Dot-Initiated Workflow — observation → claim → execution → learning
category: Architecture
tags: [dot, workflow, work-item, inbox, wake, autonomy, ops-health-probe]
importance: 8
last_updated: 2026-10-17
---

# Dot-Initiated Workflow

The end-to-end autonomous loop by which an operational observation becomes
claimed, executed, and learned-from work — verified live on 2026-10-17
(`ops-finding:alert_dominance:dd58dd312fc8ea13` ran claim → in_progress → done
with a real advisory diagnosis).

## 1. The loop

```
Observe   ops-health-probe (daily) / heartbeat watchdog (5 min)
            → ops-findings.jsonl (deduplicated by finding_id)
File      findings → WorkItem for the ops dot + one coalesced inbox wake
Wake      dot-inbox.jsonl row → evaluateDotTriggersDue → wake ledger (delivered)
Claim     executor step (runs before wakes each sweep) → claimWorkItem
Execute   route by metadata.requested_work_shape → outcome → report-back inbox row
Record    executor report → work-results.jsonl → dot outcome-continuation wake
Learn     autonomy-outcomes ledger → promotion/demotion sweep → knowledge distill
```

## 2. Claimable-WorkItem contract (hard-won invariants)

A probe/agent filing a WorkItem for a dot MUST satisfy all of these, or the
item sits unclaimed forever:

| Requirement                                                                                                                                              | Failure mode when missing                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `status: 'ready'`                                                                                                                                        | default `backlog` is never claimed — executors only pick `ready`  |
| `metadata.dot_id` (or `handoff_to`)                                                                                                                      | `addressedTo()` finds no target                                   |
| `context.tenant_slug` matching the charter's tenant                                                                                                      | `dotItemTenantMismatch` → cross-tenant refusal (undefined ≠ slug) |
| `metadata.requested_work_shape`                                                                                                                          | executor escalates with missing-shape guidance                    |
| shape in `authority.allowed_work_shapes` (enforced at the step port for task_session)                                                                    | capability_unavailable refusal                                    |
| `metadata.pipeline_ref` in `authority.allowed_pipelines` for pipeline shape — **repo-relative path verbatim** (`pipelines/<name>.json`, not a bare name) | `allowed_pipelines` miss or `Resource path does not exist`        |

## 3. Wake delivery (inbox rows)

- A row with `dot_id` wakes that dot; `channel: 'inbox'` broadcast rows wake
  dots subscribed to the channel.
- Probe batches coalesce to **one wake per run** with a content-hash
  idempotency key — finding-level fan-out would flood the inbox.
- Identity conflicts (WorkItem already filed before wakes existed) count as
  existing items for wake targeting but never inflate `work_items_filed`.
- `dot-inbox` uses position-derived keys: compaction must tombstone in place,
  never delete (reindexing re-fires consumed wakes).
- Wakes alone do not claim anything: the executor claims during its sweep step,
  which runs **before** wake processing each pass.

## 4. Work-shape routing (executor)

`DotWorkShape` routes claimed items:

- `direct_reply` — one bounded advisory goal turn ("advisory result, effects
  are unverified" prefix).
- `task_session` — bounded goalTurn multi-turn, enabled **per-charter**:
  `authority.allowed_work_shapes` must declare it; the step sets
  `taskSessionUnavailable` otherwise. Sessions are advisory turns only (no
  work tools — a claimed "complete" cannot prove task execution).
- `pipeline` — runs `metadata.pipeline_ref` from `allowed_pipelines` via the
  validated pipeline runner.
- `mission` — **never started by a dot** (escalates to operator); see §5.

## 5. Mission autonomy ladder

Mission proposals flow through the evidence ladder, not direct execution:

- Dots escalate mission-shaped items (`status: blocked` + guidance).
- The watchdog sweep records a gate verdict per blocked proposal into
  `autonomy-outcomes.jsonl` — `mission_start_mandate` when the item carries
  `metadata.mandate_ref`, else `mission_start`.
- `mission_start_mandate` scores auto (2/6) but is `shadow: true` — recorded,
  never executed, until evidence promotion lifts it.
- `mission_start` (unmandated) is unregistered → fail-closed `approve`.
- Only `allowed && auto` verdicts invoke `mission_controller start`; every
  attempt (success and failure) is written back to the ledger.
- Persona-level mission handoffs (`mission_controller handoff`) transfer
  ownership of existing missions; they do not create new ones.

## 6. Autonomy outcome ledger

- Decisions are `auto | notify | approve` from scope + reversibility +
  sensitivity + confidence axis scores.
- Evidence soak: clean `notify` verdicts accumulate; an incident demotes the
  action immediately (7-day hold).
- Every gate evaluation and execution result lands in
  `autonomy-outcomes.jsonl` — the promotion/demotion sweep consumes it every
  watchdog pass for **all recorded action ids**, not just known action keys.

## 7. Alert-dominance detection

- `ops-alerts.jsonl` dedupe keys fragment across changing daemon combos, so
  dominance is grouped by **source prefix before the first colon**
  (`daemon-watchdog` measured at 94% of 2,640 rows).
- Findings rows are deduplicated by `finding_id` — the daily probe must not
  append identical rows each run.

## 8. Operational foot-guns (verified)

- Partial builds (`pnpm --filter @agent/core` alone, or `build:repo` alone)
  leave dist targets missing — run the full `pnpm exec tsc -b tsconfig.json`
  plus `build:bundle`; `scripts/check_stale_dist.js` must report OK before
  trusting integration results. Daemons run the bundle, not source.
- A running supervisor executes the bundle it started with — merged code
  reaches the daemon via the `stale_code` heartbeat → governed restart path,
  not by editing source.
- Filed test items are consumed by the live daemon's next sweep — race it by
  filing and invoking `runDotExecutorStep` in one process.

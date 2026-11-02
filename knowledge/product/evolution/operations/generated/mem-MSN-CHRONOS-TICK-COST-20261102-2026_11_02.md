---
record_id: mem-MSN-CHRONOS-TICK-COST-20261102-2026_11_02
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CHRONOS-TICK-COST-20261102-2026_11_02
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-02T05:52:54.047Z
source_branch: fix/chronos-tick-cost-20261102
source_commit: f85a4ed6f7687fba89135a55e2a9730a49ae303c
---

# Daemon ticks must not grow with history, and scheduled scripts must assume their own role

A per-tick sweep that re-parsed every pipeline run journal reached 180 s and kept the chronos heartbeat stale; memoise settled records by file size+mtime and yield during long passes. A scheduled script run as a pipeline shell step inherits the runner role, so it must assume its own narrow role around its writes.

## Procedure Steps

1. In MSN-CHRONOS-TICK-COST-20261102 the chronos heartbeat went stale and chronos sat at ~82% CPU. Rules learned:

- Work a daemon repeats every tick must cost what changed, not what accumulated. sweepAwaitStateRuns re-read and schema-validated all 1603 pipeline run journals (65 MB) every 60 s to find zero suspended runs: 180 s per sweep, exactly the watchdog stale threshold. Memoise settled records by a signature of their files (path:size:mtimeMs; append-only journals always change size). Never memoise records that must be re-evaluated (state suspensions with timeouts) or read errors (an error that clears on the next read would otherwise hide a suspended run until its file changes), and prune entries whose files vanished.
- A long synchronous pass blocks the heartbeat refresh timer even when one exists; yield with setImmediate on a time budget (25 ms) so timers fire.
- Measure a daemon hot path on the live checkout, not only in unit tests: the cost only appears with months of history.
- A script run by a schedule as a pipeline system:shell step inherits the runner role (observed run_pipeline.bundle) through MISSION_ROLE; the role derived from the script file name never applies. Register a narrow role and assume it with withExecutionContext around the write, and run the schedule pipeline once.
- Under the repo root Vitest does not load the security policy, so every tier-guard verdict is allowed; permission tests must copy the governance policies into a hermetic KYBERION_ROOT and must fail when the policy entry is removed.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-CHRONOS-TICK-COST-20261102/evidence/implementation-report.md
- active/missions/public/MSN-CHRONOS-TICK-COST-20261102/evidence/test-report.md
- active/missions/public/MSN-CHRONOS-TICK-COST-20261102/evidence/REVIEW-execution-implement.md

## Artifacts

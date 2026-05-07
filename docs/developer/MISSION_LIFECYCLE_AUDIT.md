---
title: Mission Lifecycle Audit (Phase B-3)
category: Developer
tags: [mission, lifecycle, idempotency, audit]
importance: 9
last_updated: 2026-05-07
---

# Mission Lifecycle Audit — Phase B-3

Audit of `mission_controller` for 24h+ continuous operation. Goal: a mission can survive checkpoint→suspend→resume cycles, process crashes, and concurrent commands without losing work or corrupting state.

This document is the **input** to Phase B-3 hardening work.

## 1. Summary

| Concern | Status | Severity |
|---|---|---|
| Concurrent state modification | 🟡 partial | high |
| Duplicate RESUME entries | 🔴 not handled | medium |
| Stale lock detection | ✅ done (PID-based via `lock-utils.ts`) | — |
| Heartbeat / liveness | 🔴 not present | medium |
| Periodic auto-checkpoint | 🔴 not present | medium |
| Process-crash recovery | 🟡 partial (state survives, in-flight changes may not) | high |
| 24h+ e2e test | 🔴 not present | high |
| Trace integration in checkpoint | ✅ done (this PR, F7) | — |

Overall: the foundation is sound (file-based locks with stale detection, atomic state writes, mission-scoped git repos). The gaps are at the **edges**: read-modify-write sequences that escape the lock, missing liveness signals, and untested long-running scenarios.

## 2. Detailed Findings

### F1. resumeMission has a TOCTOU race — **fixed in this PR**

`scripts/refactor/mission-maintenance.ts::resumeMission` previously did:

```typescript
const state = loadState(targetId);          // read
state.history.push({ event: 'RESUME', ... }); // modify
await saveState(targetId, state);            // write (lock acquired here)
```

If a `checkpoint` command ran between the `loadState` and `saveState`, the resume would overwrite the checkpoint's changes.

**Fix**: wrap read-modify-write in `withLock`, re-load state inside the lock, write with `alreadyLocked: true`. Implemented in this PR.

### F2. Duplicate RESUME entries

Every call to `resumeMission` appends a `RESUME` history record. If a script crashes and is restarted multiple times (or if a worker auto-restarts), history bloats.

**Fix in this PR**: idempotency window — if the last history event was a `RESUME` within 60 seconds, skip the duplicate.

**Follow-up**: consider a configurable window or a per-orchestrator id key for finer-grained dedup.

### F3. No heartbeat / liveness

`mission-state.json` has no `last_heartbeat_at` or equivalent. An orchestrator watching missions can't tell:

- Is this mission actively progressing or stuck?
- Did the process holding it die?

The lock file's PID can hint, but the lock is only held during write transactions, not for the whole mission lifetime.

**Recommendation (follow-up)**: add `last_heartbeat_at` and `heartbeat_pid` to `MissionState`. Update via a background interval timer in the supervising process. Surfaces in `mission_controller status`.

### F4. No periodic auto-checkpoint

For a 24h mission, if the user only runs `checkpoint` once, recovery from a process crash 12 hours in loses 12 hours of work.

**Recommendation (follow-up)**: optional `--auto-checkpoint=<minutes>` flag on `start`, plus a default cadence (e.g. every 30 min) when running under the orchestrator.

### F5. Process-crash recovery is partial

If a process crashes:

- ✅ The mission state on disk survives (atomic writes via `safeWriteFile`).
- ✅ Stale locks are detected and cleared by next run.
- ✅ The mission's git repo retains all completed checkpoints.
- ❌ In-flight, uncommitted changes are lost (expected — git contract).
- ❌ The `LATEST_TASK.json` flight recorder hints at the last *intended* task but the user must manually verify physical state.

**Recommendation (follow-up)**: when resuming, automatically run `git status` in the mission repo and surface dirty files to the user.

### F6. No 24h+ e2e test

There is no automated test that:

1. Creates a mission
2. Runs N checkpoints over time
3. Simulates a process restart (suspend + spawn fresh process to resume)
4. Verifies state integrity, history monotonicity, and checkpoint count

**Recommendation (this PR)**: skeleton e2e test added under `scripts/refactor/mission-lifecycle-24h.test.ts` covering:

- start → multiple checkpoints → suspend (process exit simulation) → fresh resume → finish
- concurrent checkpoint attempts under contention
- duplicate resume (idempotency check)

The full 24h time-compressed test (running for hours under chaos conditions) is a future Phase B-5 chaos drill.

### F7. Trace integration in checkpoint — **done in this PR**

Per Phase B-1.5: `mission_controller` checkpoint events now emit Trace spans.

`recordCheckpointForMission` is wrapped in a `TraceContext` keyed on the mission id. Spans are emitted for:

- `git.stage` — `git add .`
- `git.commit` — commit creation (or `git.commit.skipped_no_changes` event when state-only)
- `state.save` — mission-state.json write under lock
- `project_ledger.sync` — outside the lock
- `intent_delta.emit` — outside the lock

The trace is persisted via `persistTrace()` to `active/shared/logs/traces/` (or `customer/{slug}/logs/traces/` when KYBERION_CUSTOMER is active). Persistence failures are logged as warnings and never fail the checkpoint itself.

## 3. What This PR Changes

- [x] **F1 fix**: `resumeMission` re-loads state inside the lock; uses `alreadyLocked` for the save.
- [x] **F2 fix**: 60s RESUME idempotency window. Duplicate resumes within the window are no-ops with a clear log.
- [x] **F6 partial**: idempotency unit test (`scripts/refactor/mission-maintenance.test.ts`) covering 9 scenarios. Full process-restart e2e test is Phase B-5.
- [x] **F7 done**: `recordCheckpointForMission` emits a Trace with spans for git.stage, git.commit, state.save, project_ledger.sync, intent_delta.emit. Persisted via `persistTrace()`.

## 4. What This PR Does NOT Change

- F3 heartbeat — design needed first (next PR).
- F4 auto-checkpoint — needs scheduler integration with `agent-runtime-supervisor`.
- F5 dirty-state surfacing on resume — small but separate change.

## 5. Acceptance Criteria for Phase B-3 Closure

| # | Criterion | Status |
|---|---|---|
| AC1 | `resumeMission` is idempotent across multiple invocations | ✅ |
| AC2 | Concurrent `checkpoint` and `resume` cannot lose data | ✅ (after F1/F2) |
| AC3 | Mission has a heartbeat that orchestrator can read | ❌ deferred |
| AC4 | A 24h e2e test passes (time-compressed, with simulated crashes) | 🟡 skeleton only |
| AC5 | `mission_controller status` surfaces dirty files on resume | ❌ deferred |
| AC6 | Checkpoint events are emitted as Trace spans | ✅ |

Phase B-3 closes when AC1–AC6 are all green. This PR closes AC1, AC2, AC6, and the skeleton portion of AC4.

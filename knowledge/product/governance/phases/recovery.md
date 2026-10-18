---
title: 'Phase Protocol: Recovery & Resilience'
tags: [governance, lifecycle, recovery]
last_updated: 2026-10-18
runtime_stages: [preflight, execution]
---

# Phase Protocol: ② Recovery & Resilience

## Goal

Autonomous return from interruptions, infrastructure self-healing, and state restoration.
This phase ensures the agent has a solid physical foundation before attempting any high-level tasks or interactions.

## Trigger Conditions

This phase is triggered by the **Phase Detection Protocol** under two distinct circumstances:

1. **Infrastructure Damage**: The `baseline-check` pipeline returns `status: "needs_recovery"` (failure in L0, L1, or L2).
2. **Stale Lock Detection**: The `baseline-check` pipeline detects an interrupted mission lock (e.g., `.kyberion.lock` or `active/shared/runtime/locks/`).

---

## Directive A: Infrastructure Self-Healing (L0 - L2)

If the physical or neural base of the ecosystem is broken or uninitialized, the agent MUST auto-fix it before proceeding.

### 1. Neural Layer (L1) Recovery

- **Condition**: Missing or incomplete `node_modules`.
- **Action**: Run `pnpm install`
- **Goal**: Re-establish internal links and SDK availability.

### 2. Skeletal Layer (L2) Recovery

- **Condition**: Missing build artifacts (`dist/` directories).
- **Action**: Run `pnpm build`
- **Goal**: Compile TypeScript and package the runtime.
- **Observation versus repair**: repeated L2 checks do not count as build attempts. The canonical
  `pnpm build`, `pnpm build:packages` and `pnpm build:repo` entrypoints record completed compiler
  commands; a failed command consumes one recovery attempt. A successful command resets it only
  when the complete compiler output tree also passes import and freshness checks. A partial build
  that leaves other targets stale records `restored: false` and retains the existing budget.
  UI-only failures do not consume the compiler budget. Legacy observation counts are retained as
  `legacy_observation_attempt_count`, not treated as failed repairs.
- **Build in progress**: builds and baseline scans share the `compiler-outputs` lock. A busy
  scan reports `needs_attention` with `deferred: true`; wait for the active build rather than
  launching another recovery. Inspect `build_readiness` and L2's `last_observation` for exact
  source/output paths, failure fingerprint and timestamp; `last_recovery` identifies the last
  completed compiler command. Do not delete the PFC state to clear a failure.

### 3. Circuit Breaker Constraint

- If the `baseline-check` reports `needs_recovery` with `circuit_broken: true`, the agent **MUST NOT**
  attempt further automated recovery. Surface the failed layer and recorded evidence to the
  Sovereign. For L2, the budget counts completed failed compiler commands, not health polls.
  An explicit operator-authorized build remains available; a successful subsequent health probe
  also closes the circuit. A deferred observation never requests another automatic build.

---

## Directive B: Mission Recovery & Stale Locks

Once the infrastructure (L0-L2) is stable, the agent handles aborted missions.

### 1. Lock-Based Recovery Priority

- Read `.kyberion.lock` (or runtime lock files) to instantly identify the interrupted `mission_id`.
- **Action**: `node dist/scripts/mission_controller.js resume`

### 2. Context Reconstruction

- Restore the exact prior state by reading the `mission-state.json` and the Flight Recorder (`LATEST_TASK.json`).
- **Volatile working-memory context** (Volatile Knowledge Layer — `docs/VOLATILE_KNOWLEDGE_PLAN.ja.md § Phase 5`):
  1. Read `active/missions/<TIER>/<MISSION_ID>/NOW.md` for the last known focus and next action.
  2. Read `active/missions/<TIER>/<MISSION_ID>/MEMORY.md` for open action items, decisions, and open questions.
  3. If a personal session was interrupted, also read `active/personal/today/TODO.md` and the latest `active/personal/journal/<date>.md`.
  4. Check `active/shared/MEMORY.md` for any global action items relevant to this recovery.
  5. Summarize these volatile faces into a one-paragraph context brief and surface it to the operator before resuming.
- Run `pnpm pipeline --input pipelines/volatile-gc.json` to expire stale session faces and roll over any unfinished daily items before resuming.
- Stale locks will be automatically purged by the mission controller if the locking PID is dead.

### 3. Constraints

- **Recovery Logic**: Restore the exact prior state. Do not invent a new path until the prior state is stable.
- **State Freshness**: 1-hour freshness for active mission states must be strictly enforced via `validateFileFreshness`.

---

_Status: Mandated by AGENTS.md (Sentinel Architecture)_

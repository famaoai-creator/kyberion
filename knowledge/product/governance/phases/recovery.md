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

### 3. Circuit Breaker Constraint
- If the `baseline-check` reports `circuit_broken: true`, the agent **MUST NOT** attempt further automated recovery. It must stop and ask the Sovereign for manual intervention (e.g., "Dependency resolution failed 3 times. Please check package.json").

---

## Directive B: Mission Recovery & Stale Locks
Once the infrastructure (L0-L2) is stable, the agent handles aborted missions.

### 1. Lock-Based Recovery Priority
- Read `.kyberion.lock` (or runtime lock files) to instantly identify the interrupted `mission_id`.
- **Action**: `node dist/scripts/mission_controller.js resume`

### 2. Context Reconstruction
- Restore the exact prior state by reading the `mission-state.json` and the Flight Recorder (`LATEST_TASK.json`).
- Stale locks will be automatically purged by the mission controller if the locking PID is dead.

### 3. Constraints
- **Recovery Logic**: Restore the exact prior state. Do not invent a new path until the prior state is stable.
- **State Freshness**: 1-hour freshness for active mission states must be strictly enforced via `validateFileFreshness`.

---
*Status: Mandated by AGENTS.md (Sentinel Architecture)*

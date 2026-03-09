# Phase Protocol: ② Recovery & Resilience

## Goal
Autonomous return from interruptions and self-healing.

## Trigger Condition
This phase is automatically triggered by the **Phase Detection Protocol** when the `.kyberion.lock` file is found in the workspace root at the start of a session, indicating a previous mission was abruptly halted.

## Directives
1. **Lock-Based Recovery Priority**: Read `.kyberion.lock` to instantly identify the interrupted `mission_id`.
2. **Context Reconstruction**: Restore the exact prior state by reading the `mission-state.json` and the Flight Recorder (`LATEST_TASK.json`).
3. **Stale Lock Purging**: Rely on the mission controller to automatically verify if the locking PID is dead and safely purge the lock if it is stale.
4. **Resilience**: Unexpected interruptions are opportunities for evolution. Auto-stash dirty state and resume precisely from the point of suspension.

## Constraints
- **Recovery Logic**: Restore the exact prior state. Do not invent a new path until the prior state is stable.
- **State Freshness**: 1-hour freshness for active mission states must be strictly enforced.

## Physical Enforcement
The agent MUST use the mission controller to resume, which handles auto-stashing uncommitted debris, clearing stale locks, and checking out the correct branch safely.

- **Command**: `npx tsx scripts/mission_controller.ts resume` (It will automatically detect the target ID from the lock file or registry)
- **Validation**:
  - Verification of `mission-state.json` freshness via `validateFileFreshness`.
  - Automatic git branch verification to match the mission context.

---
*Status: Mandated by GEMINI.md*

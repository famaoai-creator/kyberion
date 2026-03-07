# Phase Protocol: ② Recovery & Resilience

## Goal
Autonomous return from interruptions and self-healing.

## Directives
1. **Recovery Priority**: Scan `active/missions/` for any mission with `status: "active" | "paused"`.
2. **Context Reconstruction**: Restore the exact prior state and resume from the point of suspension.
3. **Stale State Management**: Identify if the mission state is outdated (>1 hour) and trigger an Alignment check if necessary.
4. **Resilience**: Unexpected interruptions are opportunities for evolution.

## Constraints
- **Recovery Logic**: Restore the exact prior state. Do not invent a new path until the prior state is stable.
- **State Freshness**: 1-hour freshness for active mission states must be strictly enforced.

## Physical Enforcement
The agent MUST use the mission controller to resume and validate the current state.

- **Command**: `npx tsx scripts/mission_controller.ts start <MISSION_ID>` (to resume)
- **Validation**:
  - Verification of `mission-state.json` freshness via `validateFileFreshness`.
  - Automatic git branch verification to match the mission context.

---
*Status: Mandated by GEMINI.md*

# MSN-REFAC-VERIFY-001: Mission Lifecycle & Dispatch Smoke Summary

## Overview

A review of the mission lifecycle and dispatch flow following the recent refactor (splitting `mission_controller.ts` into core modules) has identified several regressions related to mission finalization and state isolation.

## Breakpoints Observed

### 1. Ghost Directory Recreation (Lifecycle Regression)
In `scripts/refactor/mission-lifecycle.ts`, the `finishMission` function archives the mission by moving its directory to the archive tier and then deleting the active directory. However, it calls `saveState` *after* this deletion to record the final `archived` status.
- **Root Cause**: `saveState` in `scripts/refactor/mission-state.ts` recreates the mission directory if it doesn't exist.
- **Effect**: Every finished mission leaves a "ghost" directory in the active tier containing only `mission-state.json`.

### 2. Status Blindness in Dispatch (Dispatch Regression)
The refactored `dispatchMissionWorkItems` in `scripts/refactor/mission-workitem-dispatch.ts` lacks status guards.
- **Root Cause**: The function selects and executes work items based on labels and project IDs without verifying if the mission status is `active`.
- **Effect**: Work items can be dispatched against `archived` missions if the "ghost" directory exists, leading to fragmented audit trails and inconsistent state.

### 3. Artifact Fragmentation
Because work items can be dispatched after archiving, new evidence files and event logs (`workitem-dispatch.jsonl`) are created in the "ghost" active directory instead of the archived repository.
- **Effect**: The permanent record of the mission (the archive) is incomplete, and runtime artifacts leak into the active workspace.

## Exact Steps Reproduced

1.  **Execute `finishMission`**:
    - Directory `active/missions/public/MSN-REFAC-VERIFY-001` is moved to `active/archive/missions/MSN-REFAC-VERIFY-001`.
    - `active/missions/public/MSN-REFAC-VERIFY-001` is deleted.
    - `saveState` is called; it recreates `active/missions/public/MSN-REFAC-VERIFY-001/mission-state.json`.
2.  **Execute `dispatchMissionWorkItems`**:
    - Dispatcher loads state from the "ghost" directory.
    - Status is `archived`, but dispatch continues.
    - `witem-09a6ec06` (and others) are processed.
    - Evidence is written to `active/missions/public/MSN-REFAC-VERIFY-001/evidence/`.
    - Event is appended to `active/missions/public/MSN-REFAC-VERIFY-001/coordination/events/workitem-dispatch.jsonl`.

## Recommendations

1.  **Fix `saveState` / `finishMission`**: Ensure the final state save for archived missions writes to the *archived* path, not the active path, or prevent `saveState` from recreating directories for archived statuses.
2.  **Add Status Guards**: Update `dispatchMissionWorkItems` to throw an error if the mission status is not `active` or `validating`.
3.  **Audit `missionSystem`**: Review post-action hooks (like `syncProjectOperationalStateIfLinked`) to ensure they handle archived states gracefully without triggering side effects in the active tier.

---
**Deliverable**: `evidence/lifecycle-smoke-summary.md`
**Status**: Regression Identified

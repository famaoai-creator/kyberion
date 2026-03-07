# Phase: Recovery & Resilience
## Goal
Autonomous return from interruptions and self-healing.

## Directives
1.  **State Reconstruction**: Scan `mission-state.json` and recent logs to identify the exact point of interruption.
2.  **Conflict Resolution**: Check for inconsistent file states or locked resources caused by the crash.
3.  **Autonomous Intervention**: If an MLE signal is detected, intervene with reasoning before resuming automated steps.
4.  **Self-Healing**: Trigger the Autonomous Debug Loop if the interruption was caused by a system error.

## Constraints
- **State Integrity**: Do not resume execution if the mission state is corrupted; seek Sovereign clarification.
- **Minimal Rework**: Aim to restore state without redundant processing of already completed tasks.
- **Traceability**: Record the recovery event and its cause in the mission evidence.

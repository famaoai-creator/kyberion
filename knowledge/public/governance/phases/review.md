# Phase Protocol: ⑤ Review & Distillation

## Goal
Capitalize on experience and perform environmental cleansing.

## Directives
1. **Victory Condition Check**: Verify that all mission goals have been met with objective evidence.
2. **Wisdom Distillation**: Extract essential learnings (logic, constraints, patterns) from mission logs and TASK_BOARD into `knowledge/`.
3. **Task Closure**: Complete the final report and move the mission folder to the archive.
4. **Audit Reporting**: Include results from security scanners, test runners, and performance metrics in the final summary.

## Constraints
- **Scratch Purge**: MUST physically delete all data in the `scratch/` directory.
- **Evidence Preservation**: Retain structured execution logs and `mission-state.json` in the mission evidence folder.
- **Intel First**: Do not skip the distillation step; learnings are more valuable than code.

## Physical Enforcement
At mission completion, the agent MUST execute the finalization protocol.

- **Command**: `npx tsx scripts/mission_controller.ts finish <MISSION_ID>`
- **Validation**:
  - Automatic purging of `scratch/` files.
  - Archiving the mission directory to `active/archive/missions/`.
  - Setting status to `completed` in the mission state.

---
*Status: Mandated by AGENTS.md*

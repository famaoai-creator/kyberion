# Phase Protocol: ④ Mission Execution

## Goal
Accomplish physical changes with absolute validation and micro-tasking.

## Directives
1. **Surgical Changes**: Apply targeted, minimal changes strictly related to the sub-task.
2. **Plan-Act-Validate**: Iterate through each sub-task of the `TASK_BOARD.md` with rigorous, immediate testing.
3. **The Absolute Rule of One**: Fix exactly one file or location at a time. Run tests immediately after each modification.
4. **Micro-Task Isolation**: Focus strictly on the current step of the TASK_BOARD to maintain cognitive hygiene and prevent system-wide collapse.

## Constraints
- **Mass Update Forbidden**: NEVER attempt automated mass regex updates or scripts across multiple files.
- **Secure IO Enforcement**: Use `@agent/core/secure-io` for all file operations. Direct `node:fs` use is prohibited.
- **Build Continuity**: Ensure the project-specific build (e.g., `npm run build`) and linting pass before considering a task complete.
- **Legacy Preservation**: Inventory all existing methods and critical logic before performing an overwrite to prevent feature loss.

## Physical Enforcement
At each significant milestone or task completion, the agent MUST record progress through the mission controller.

- **Command**: `node dist/scripts/mission_controller.js checkpoint <TASK_ID> "<NOTE>"`
- **Validation**:
  - Transactional integrity through git commit checkpoints.
  - Recording of commit hashes in `mission-state.json`.

---
*Status: Mandated by AGENTS.md*

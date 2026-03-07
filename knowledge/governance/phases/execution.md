# Phase Protocol: ④ Mission Execution

## Goal
Accomplish physical changes with absolute validation through micro-tasking.

## Directives
1. **The Absolute Rule of One**: Fix and refactor exactly one location at a time. Never attempt mass updates across multiple unrelated files.
2. **Plan-Act-Validate**: Iterate through each sub-task of the `TASK_BOARD.md` with rigorous, immediate testing.
3. **Micro-Task Isolation**: Focus strictly on the current step to maintain cognitive hygiene and prevent large-scale system collapse.
4. **Surgical Changes**: Apply targeted, minimal changes strictly related to the current sub-task.

## Constraints
- **Secure IO Enforcement**: Use `@agent/core/secure-io` for all file operations. Direct `node:fs` use is prohibited.
- **Build Continuity**: Ensure the project-specific build (e.g., `npm run build`) and linting pass before considering a task complete.
- **Legacy Preservation**: Inventory all existing methods and critical logic before performing an overwrite to prevent feature loss.

## Physical Enforcement
At each significant milestone or task completion, the agent MUST record the progress through the mission controller.

- **Command**: `npx tsx scripts/mission_controller.ts checkpoint <TASK_ID> "<NOTE>"`
- **Validation**:
  - Transactional integrity through Git commit checkpoints.
  - Recording of commit hashes in `mission-state.json`.

---
*Status: Mandated by GEMINI.md*

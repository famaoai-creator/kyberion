# Phase: Mission Execution
## Goal
Accomplishment of physical changes and absolute validation.

## Directives
1.  **Surgical Changes**: Apply targeted, minimal changes strictly related to the sub-task.
2.  **Plan-Act-Validate**: Iterate through each sub-task with rigorous testing.
3.  **Absolute Rule of One**: Fix exactly one file/location at a time. Run tests immediately after.
4.  **Micro-Task Isolation**: Focus only on the current step of the TASK_BOARD to maintain cognitive hygiene.

## Constraints
- **Mass Update Forbidden**: Never attempt automated mass updates across multiple files.
- **Secure IO Enforcement**: Use `@agent/core/secure-io` for all file operations.
- **Build Continuity**: Ensure `npm run build` passes before considering a task complete.
- **Legacy Preservation**: Inventory existing methods/logic before overwriting to prevent feature loss.

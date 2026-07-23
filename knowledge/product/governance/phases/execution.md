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

At each significant milestone or task completion, the owner agent MUST record progress through the mission controller. Worker agents should report through mission-local coordination artifacts for owner acceptance.

- **Command**: `node dist/scripts/mission_controller.js checkpoint <MISSION_ID> <TASK_ID> "<NOTE>"`
- **Post-verification evidence**: `node dist/scripts/mission_controller.js record-evidence <MISSION_ID> <TASK_ID> "<NOTE>" --evidence <CSV>`
- **Validation**:
  - Transactional integrity through git commit checkpoints.
  - Recording of commit hashes in `mission-state.json`.
  - Evidence records append to `execution-ledger.jsonl` and refresh `git.latest_commit`.

**`record-evidence` closes a normal `NEXT_TASKS.json` task automatically** once the task's own
`deliverable` file exists and every dependency it lists is already completed — this is what
makes the plain checkpoint + record-evidence flow actually reach `finish` without a manual
`NEXT_TASKS.json` edit. `checkpoint` itself still only appends to the execution ledger.

**Review-kind tasks are the one exception — `record-evidence` alone can NEVER close them.**
A task with `phase_kind: "review"` (e.g. `self_review-code-review`), or `assigned_to.role`
of `reviewer`/`qa`, or a `review_target` field, requires a real, independently-verified
`ArtifactReviewReceipt` instead of bare file existence — dropping a plausible-looking file at
`evidence/REVIEW-*.md` and calling `record-evidence` on it will not complete the task. Use:

```
node dist/scripts/mission_controller.js review-task <MISSION_ID> <review_task_id> <reviewer_agent_id> \
  [--findings <JSON>] [--reviewer-team-role reviewer|qa] [--specialist-roles <CSV>]
```

This hashes the reviewed artifact (`task.review_target`'s own deliverable), computes who
actually recorded evidence for that target from the execution ledger, and rejects the review
if the reviewer agent id is the same as an implementer agent id, or if any finding is
`severity: "blocking"` — independence is verified from what actually happened in this
mission, not self-declared by the caller. This is exactly the gap an adversarial review of
this process itself found (a single-reviewer pass approving via a bare placeholder file);
see `knowledge/product/architecture/browser-execution-substrate-howto.md`'s "Review process
note" for how that was discovered, and treat every review-kind task the same way going
forward — spawn a genuinely independent reviewer (a distinct subagent, not yourself), then
record its verdict with `review-task`, not `record-evidence`.

When the owner agent does the work **directly** rather than through `dispatch-workitems`
(the common case for a single agent working solo through a mission), adopt non-review work
that already happened outside this flow with:

```
node dist/scripts/mission_controller.js reconcile-work <MISSION_ID> --manifest <path> [--dry-run]
```

The manifest is a `mission-work-reconciliation` document (see
`scripts/refactor/mission-work-reconciliation.ts`) listing, per task, the evidence files
(with `sha256`), the acceptance criteria satisfied, and a verification block (command run,
exit code). Run with `--dry-run` first to validate the manifest before it mutates
`NEXT_TASKS.json` task status.

---

_Status: Mandated by AGENTS.md_

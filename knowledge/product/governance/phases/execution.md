---
title: 'Phase Protocol: Mission Execution'
tags: [governance, lifecycle, execution]
last_updated: 2026-09-22
runtime_stages: [contract_authoring, preflight, execution]
---

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

### Direct CLI work (worktree / subagents / external PR): the flow that reaches `finish`

Most work is done **directly** — the owner agent edits code in a worktree, delegates to
subagents, and another agent (e.g. Codex) reviews and merges the PR — not through
`dispatch-workitems`. That path reaches `finish` without manual repair **only if each
template task is recorded while the work happens**. Verified end to end on 2026-09-22
(probe mission, ~2 minutes, no human approval needed):

1. **Start from the main checkout.** Run `mission_controller create/start` where the
   operator profile lives (a fresh worktree has no `knowledge/personal/` onboarding and
   `create` fails). Code can still live in a worktree. On macOS the mission repo's git needs
   the Xcode license accepted.
2. **Read the task deliverables first.** `NEXT_TASKS.json` fixes one `deliverable` path per
   task (template `development`: `evidence/requirements-draft.json`,
   `evidence/implementation-plan.json`, `evidence/design-spec.json`,
   `evidence/implementation-report.md`, `evidence/test-report.md`,
   `evidence/REVIEW-execution-implement.md`, `evidence/delivery-report.md`,
   `evidence/retrospective.md`). A task closes only when _that_ file exists.
3. **Close each task as its phase ends**, in dependency order — write the deliverable
   (real content: requirements from the user's words, the plan, test output, PR / merge
   commit, …) and run:

   ```
   node dist/scripts/mission_controller.js record-evidence <MISSION_ID> <TASK_ID> "<NOTE>" \
     --evidence <deliverable,...> --actor-id <agent that did it> --team-role <planner|implementer|reviewer>
   ```

   `--actor-id` is not optional in practice: `review-task` computes reviewer independence
   from the actor ids recorded for the review target, and without them review is rejected
   ("implementer identity is missing").

4. **Review with a different agent.** After an independent reviewer (a distinct subagent,
   or the agent reviewing the PR) has reviewed, record its verdict, then close the review
   task with its own deliverable:

   ```
   node dist/scripts/mission_controller.js review-task <MISSION_ID> self_review-code-review <reviewer_agent_id> \
     --specialist-roles code-reviewer --findings '<JSON array>'
   # review-task records the receipt but does not close the task by itself:
   #   write evidence/REVIEW-execution-implement.md, then
   node dist/scripts/mission_controller.js record-evidence <MISSION_ID> self_review-code-review "<NOTE>" \
     --evidence evidence/REVIEW-execution-implement.md --actor-id <reviewer_agent_id> --team-role reviewer
   ```

5. Record delivery (PR URL, merge commit) and retrospective the same way, then
   `verify <ID> verified "<note>"` → `distill <ID>` → `finish <ID>`.

**Do not leave recording until the end and fall back to `reconcile-work`.** That verb adopts
work produced _outside_ a mission and is deliberately strict: every evidence file must be
tracked unchanged at the manifest's source commit, review tasks need an
`artifact-review-receipt` whose implementer identity comes from the execution ledger (it
cannot be self-declared), and `apply` requires an authenticated human approval
(`--request-approval`, then `--approval-request-id`). Reaching for it at the end of direct
work stalls the mission; use it only for genuine adoption of external work, and plan the
human approval up front.

Other traps seen on this path:

- A failed `finish` returns the mission from `distilling` to `active` (the distillation
  output is kept); fix the gate cause, then `verify` → `distill` → `finish` again.
- `checkpoint` only appends to the ledger; it never closes a task.
- In zsh, a multi-word command stored in a variable (`MC="node … mission_controller.ts"`;
  `$MC verify …`) is not word-split and silently does nothing — use an array or the full
  command.

---

_Status: Mandated by AGENTS.md_

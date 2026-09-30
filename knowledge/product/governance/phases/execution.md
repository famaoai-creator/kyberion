---
title: 'Phase Protocol: Mission Execution'
tags: [governance, lifecycle, execution]
last_updated: 2026-09-30
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

Most work is done **directly** — the owner agent edits code in a worktree and delegates to subagents — not necessarily through `dispatch-workitems`. Use WorkItems when durable assignment, claims/leases, delegated execution, handoff, or independent review needs coordination evidence. For a single-owner direct task, `NEXT_TASKS` deliverables plus `record-evidence` are sufficient; a coordination message alone is never completion evidence. That path reaches `finish` without manual repair **only if each
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
   # --findings must match artifact-review-receipt.schema.json:
   #   [{"severity":"blocking"|"suggestion","category":"…","description":"…",
   #     "required_action"?:"…","location"?:"…"}]
   # Only "blocking" makes the verdict changes_requested. Map reviewer scales
   # (major/minor/nit) onto it: an unresolved must-fix is blocking; a finding
   # already fixed is recorded as a suggestion ("[major, resolved] …").
   # Anything else is rejected with [ARTIFACT_REVIEW_INVALID].
   # review-task records the receipt but does not close the task by itself:
   #   write evidence/REVIEW-execution-implement.md, then
   node dist/scripts/mission_controller.js record-evidence <MISSION_ID> self_review-code-review "<NOTE>" \
     --evidence evidence/REVIEW-execution-implement.md --actor-id <reviewer_agent_id> --team-role reviewer
   ```

5. **Ship the learnings in the same PR as the code.** Before opening the PR, run
   `verify <ID> verified "<note>"` → `distill <ID>`, then curate the product-domain
   lesson and promote it into the feature worktree so it is committed on the PR branch:

   ```
   pnpm mission memory-queue queued          # find the candidate distill enqueued
   pnpm mission memory-review <candidate_id>
   pnpm mission memory-approve <candidate_id> --knowledge-domain product \
     --approval-channel pr_review --curation-json '<title/summary/content/evidence_refs>'
   pnpm mission memory-promote <candidate_id> --target-root <feature worktree>
   # commit the generated record (+ `pnpm generate:knowledge-index`) on the PR branch
   ```

   Only the `product` domain goes into a PR. Organization / personal lessons follow the
   review phase's promotion path and never enter the repository; a candidate with nothing
   reusable is closed with `memory-reject <candidate_id> --note "<reason>"`. Declare every
   candidate in the PR body's `## Knowledge` section — `pnpm kyberion pr create` blocks when
   a mission candidate is unresolved, undeclared, or its record is missing from the diff
   (no skip flag). The PR review is the steward review of the lesson.

6. After merge, record delivery (PR URL, merge commit) and retrospective the same way,
   `git fetch origin main`, then `finish <ID>`. `finish` ratifies each `pr_review`
   candidate by confirming its record exists on `origin/main`; if it is not there yet,
   `finish` stops without changing mission status — fetch and re-run. Lessons that only
   surface after merge go in a small follow-up PR.

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
- `review-task --findings` must use the receipt schema — each finding is exactly
  `{"severity": "blocking" | "suggestion", "category": "...", "description": "..."}`. Other
  shapes are accepted on the command line but make the receipt invalid, and the review task
  then never closes (no error is printed).
- In zsh, a multi-word command stored in a variable (`MC="node … mission_controller.ts"`;
  `$MC verify …`) is not word-split and silently does nothing — use an array or the full
  command.

### When `finish` blocks: `mission triage` + approval-mediated close

A mission that cannot reach `finish` is diagnosed — not poked at by hand — with:

```
pnpm mission triage <MISSION_ID>            # read-only: classification + recommended commands
pnpm mission triage <MISSION_ID> --json     # machine-readable report for agents
```

The intent-drift gate is the common blocker: the mission's origin intent no longer matches
what was actually delivered, so `verify`/`finish` refuse to close it. `scope-approve`
rewrites the origin baseline, and the **direct** path deliberately requires SUDO — the
worker that drifted must not rebaseline its own contract. Instead of escalating env vars,
drive the approval-mediated path:

```
pnpm mission triage <ID> --request-approval --goal "<as-delivered goal>" --reason "<why the delivered scope is correct>"
#   → files a `mission_gate` approval request on the `mission-scope` channel whose
#     details show the human exactly what changes: current origin goal → proposed
#     goal / success condition, the reason, the drift verdict, and the effect.

# human (no PERSONA/SUDO env needed):
pnpm kyberion approvals                              # reads the full proposal inline
pnpm kyberion approvals --approve <request-id>       # or --deny <id> --note "..."

# worker (approval substitutes for SUDO; bound by hash to the exact goal/reason):
pnpm mission scope-approve <ID> --approval-request-id <request-id> --goal "<same goal>" --reason "<same reason>"
pnpm mission verify <ID> verified "<note>" && pnpm mission distill <ID> && pnpm mission finish <ID>
```

Changing the goal/reason between request and apply is rejected by the payload-hash
binding — the approval is for exactly the text the human read. When the mission should
die instead, triage recommends `cancel` → `archive --mission <ID> --execute` (no approval
required; cancel is an unguarded operator action).

**Ordering rule**: never delete the worktree before the mission reaches a terminal
status. The mission ledger is a gitignored micro-repo under `active/missions/<tier>/` of
whichever checkout ran `mission_controller` — deleting that checkout deletes the ledger
and the evidence with it. Run mission commands from the main checkout.

→ Full maintenance flow: [mission-triage-playbook](../../orchestration/mission-triage-playbook.md)

---

_Status: Mandated by AGENTS.md_

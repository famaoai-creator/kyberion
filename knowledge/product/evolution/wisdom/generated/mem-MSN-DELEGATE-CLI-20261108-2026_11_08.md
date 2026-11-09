---
record_id: mem-MSN-DELEGATE-CLI-20261108-2026_11_08
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-DELEGATE-CLI-20261108-2026_11_08
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-08T15:04:42.333Z
source_branch: refactor/package-boundary-leaves-20261107
source_commit: dc36c86f5a58dca029d7f23bcc5c0af703abdf0d
---

# Process-template task roles project to KD-05 profiles — a reviewer role without review_target bricks the template

In mission-workflow-catalog default_tasks, team_role reviewer (or any read-only-projected role) with no review_target_suffix expands to a review-kind task that fails validatePlannedNextTasks on every loadAllNextTasks — bricking dispatch for every mission using that template. Delivery/report tasks belong to team_role implementer. Guard: expand the template through expandProcessTemplateTasks + validatePlannedNextTasks in a catalog test before merging a new task.

## Hint Scope

mission

## Trigger Phrases

- When adding a default task to a mission-workflow-catalog template: (1) team_role drives both review-kind classification (reviewer => needs review_target_suffix + REVIEW-<target>.md deliverable) and the delegated KD-05 capability profile (scribe/reviewer/explorer project to read-only profiles that cannot write deliverables); (2) a reviewer task without review_target_suffix throws in expandProcessTemplateTasks and validatePlannedNextTasks, which hard-fails every mission board load for that template; (3) verify new tasks by expanding the real catalog in a test (see mission-workflow-catalog.test.ts expansion case) and checking assigned role + review_target.

## Recommended References

- active/missions/public/MSN-DELEGATE-CLI-20261108/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-DELEGATE-CLI-20261108/evidence/test-report.md

## Evidence

- active/missions/public/MSN-DELEGATE-CLI-20261108/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-DELEGATE-CLI-20261108/evidence/test-report.md

## Artifacts

---
record_id: mem-MSN-VCS-ACTUATOR-UNIFY-20261006-2026_10_06
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-VCS-ACTUATOR-UNIFY-20261006-2026_10_06
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-06T17:49:40.711Z
source_branch: feat/dogfood-lifecycle-governance-20261006
source_commit: ca2fece8485ab029924808aeb71e33a5468a5907
---

# vcs-actuator unification pattern

Single typed VCS surface in libs/core/vcs behind vcs-actuator ops; watch semantics inside ops; per-op param validation + argv flag guards; fail-closed merge gates.

## Hint Scope

mission

## Trigger Phrases

- Consolidate git/gh invocations into libs/core/vcs typed helpers (single implementation, injectable command-runner seam preserving caller testability), then expose them as vcs-actuator catalog ops. Long-poll semantics (pr_checks watch) live inside the op: poll gh pr checks --json until terminal — an empty check set right after PR creation is NOT terminal. Beware shared param enums across ops: widening `action` for worktree silently misrouted branch ops to `git branch -d` (per-op validation fixes it). Guard every argv-position param against flag injection (--force/--admin/--repo). Fail closed on merge gates: require explicit success, not absence-of-failure.

## Recommended References

- active/missions/public/MSN-VCS-ACTUATOR-UNIFY-20261006/evidence/retrospective.md
- active/missions/public/MSN-VCS-ACTUATOR-UNIFY-20261006/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-VCS-ACTUATOR-UNIFY-20261006/evidence/implementation-report.md

## Evidence

- active/missions/public/MSN-VCS-ACTUATOR-UNIFY-20261006/evidence/retrospective.md
- active/missions/public/MSN-VCS-ACTUATOR-UNIFY-20261006/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-VCS-ACTUATOR-UNIFY-20261006/evidence/implementation-report.md

## Artifacts

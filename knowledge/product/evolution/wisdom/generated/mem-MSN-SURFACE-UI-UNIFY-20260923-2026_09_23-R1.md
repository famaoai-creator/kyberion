---
record_id: mem-MSN-SURFACE-UI-UNIFY-20260923-2026_09_23-R1
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-SURFACE-UI-UNIFY-20260923-2026_09_23-R1
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T13:31:24.644Z
source_branch: fix/voice-media-session-id-20261005
source_commit: 3914948b3e61c1a44cc2ec7e79234920b20756a7
---

# Design contract first, then migrate surfaces; merged PR is not mission done

Order of work for surface unification plus a finish-gate gotcha.

## Hint Scope

mission

## Trigger Phrases

- When unifying several UI surfaces, define the shared design contract up front — A2UI component catalog, design tokens, CSS contract, and renderer behavior — then migrate each surface against it. This ordering gives implementation, review, and per-locale/theme screenshot verification a single source of truth. Governance gotcha: a verified merge is not mission completion. The finish gate still stops on pending review/delivery/retrospective task statuses even when their evidence exists — reconcile NEXT_TASKS statuses (via record-evidence/review-task), not just the PR, before finish. Verification evidence for this shape: before/after screenshot matrices per surface x locale (en/ja) x theme (light/dark) and an independent review pass with fixes recorded before merge.

## Recommended References

- active/missions/public/MSN-SURFACE-UI-UNIFY-20260923/evidence/distillation.md
- active/missions/public/MSN-SURFACE-UI-UNIFY-20260923/evidence/retrospective.md
- active/missions/public/MSN-SURFACE-UI-UNIFY-20260923/evidence/design-spec.json

## Evidence

- active/missions/public/MSN-SURFACE-UI-UNIFY-20260923/evidence/distillation.md
- active/missions/public/MSN-SURFACE-UI-UNIFY-20260923/evidence/retrospective.md
- active/missions/public/MSN-SURFACE-UI-UNIFY-20260923/evidence/design-spec.json

## Artifacts

---
record_id: mem-MSN-FINISH-SEAM-HARDENING-20261006-2026_10_06
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-FINISH-SEAM-HARDENING-20261006-2026_10_06
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-06T19:22:20.095Z
source_branch: feat/vcs-actuator-unify-20261006
source_commit: 639f599f0e15f971fa53d4f24ba0505a0f6e623d
---

# mission finish ↔ ship boundary seams

finish now warns when checkout is ahead of origin/main (unshipped deliverables); curation errors list all missing fields; gh ops forward registered tokens; vcs required-field errors unified.

## Hint Scope

mission

## Trigger Phrases

- Seam hardening observed across MSN-VCS-ACTUATOR-UNIFY + MSN-FINISH-SEAM-HARDENING: (1) finish is lifecycle-complete but not ship-aware — a mission can close while its diff sits unmerged; SHIP-01 records mission_finish_unshipped_commits {branch, ahead_of_origin_main} and warns at finish. Treat finish as advisory-complete, verify PR merge state separately. (2) Validators with allErrors-off create error-driven loops — pre-validate user-facing JSON inputs at the CLI boundary and report all missing properties at once. (3) Env-allowlisted exec boundaries need an explicit-override channel for tokens: attach registered GH_TOKEN/GITHUB_TOKEN inside ghRun so actuator and script paths have credential parity without widening ambient inheritance.

## Recommended References

- active/missions/public/MSN-FINISH-SEAM-HARDENING-20261006/evidence/retrospective.md
- active/missions/public/MSN-FINISH-SEAM-HARDENING-20261006/evidence/implementation-report.md

## Evidence

- active/missions/public/MSN-FINISH-SEAM-HARDENING-20261006/evidence/retrospective.md
- active/missions/public/MSN-FINISH-SEAM-HARDENING-20261006/evidence/implementation-report.md

## Artifacts

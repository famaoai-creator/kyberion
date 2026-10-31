---
record_id: mem-MSN-PERCEPTION-ROLE-20261031-2026_10_31
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-PERCEPTION-ROLE-20261031-2026_10_31
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-31T09:30:19.212Z
source_branch: feat/cli-reliability-20261031
source_commit: 04f86f1dc64d4a16ed057b697697702f20474ab6
---

# Wrap every perception media read in the media-worker role context via one shared helper

Role-sensitive scratch and input reads for perception commands belong inside the perception_media_worker execution context; extract the wrap as a shared helper so each new perception path inherits the authorized context in one place, and verify each path plus a denied-access case separately.

## Hint Scope

mission

## Trigger Phrases

- MSN-PERCEPTION-ROLE-20261031 fixed see/watch role violations by wrapping confidential scratch and input reads in the perception_media_worker execution context, then extracted the wrap as a shared helper (withPerceptionMediaRole) so later perception paths get the same authority boundary by construction. Verification reported 48 focused tests green; keep per-path and denied-access results separate so success and the authorization boundary stay attributable, and document residual floor-grant gaps as intentional limits.

## Recommended References

- active/missions/public/MSN-PERCEPTION-ROLE-20261031/evidence/distillation.md
- active/missions/public/MSN-PERCEPTION-ROLE-20261031/evidence/retrospective.md
- active/missions/public/MSN-PERCEPTION-ROLE-20261031/evidence/implementation-report.md
- active/missions/public/MSN-PERCEPTION-ROLE-20261031/evidence/test-report.md

## Evidence

- active/missions/public/MSN-PERCEPTION-ROLE-20261031/evidence/distillation.md
- active/missions/public/MSN-PERCEPTION-ROLE-20261031/evidence/retrospective.md
- active/missions/public/MSN-PERCEPTION-ROLE-20261031/evidence/implementation-report.md
- active/missions/public/MSN-PERCEPTION-ROLE-20261031/evidence/test-report.md

## Artifacts

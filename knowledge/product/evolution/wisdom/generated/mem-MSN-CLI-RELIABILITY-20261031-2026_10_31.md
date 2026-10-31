---
record_id: mem-MSN-CLI-RELIABILITY-20261031-2026_10_31
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CLI-RELIABILITY-20261031-2026_10_31
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-31T09:26:52.083Z
source_branch: feat/cli-reliability-20261031
source_commit: 4e5d8d880e309636eaf0840d8a44873c02430712
---

# Pin correct-contract failures with it.fails and close pending tasks before mission finish

Environment-dependent defects can be reproduced deterministically by driving real dispatch paths through synthetic scope-envelope fixtures, and a correct-but-unimplemented contract should stay red under it.fails until the fix lands; separately, recorded evidence does not complete pending mission tasks — task status must be updated and re-verified before finish.

## Hint Scope

mission

## Trigger Phrases

- MSN-CLI-RELIABILITY-20261031 reproduced an environment-dependent credential-binding failure deterministically by driving the real dispatch path through synthetic withCoordinationRoot/withScopeEnvelope/runInExecutionScope fixtures, and kept the correct contract red as it.fails until the implementing ticket arrived. The same mission recorded evidence while finish still reported pending tasks: inspect NEXT_TASKS.json status, close tasks through the mission_controller task-completion path for direct work, then repeat verification before invoking finish.

## Recommended References

- active/missions/public/MSN-CLI-RELIABILITY-20261031/evidence/distillation.md
- active/missions/public/MSN-CLI-RELIABILITY-20261031/evidence/retrospective.md
- active/missions/public/MSN-CLI-RELIABILITY-20261031/evidence/test-report.md
- active/missions/public/MSN-CLI-RELIABILITY-20261031/evidence/implementation-report.md

## Evidence

- active/missions/public/MSN-CLI-RELIABILITY-20261031/evidence/distillation.md
- active/missions/public/MSN-CLI-RELIABILITY-20261031/evidence/retrospective.md
- active/missions/public/MSN-CLI-RELIABILITY-20261031/evidence/test-report.md
- active/missions/public/MSN-CLI-RELIABILITY-20261031/evidence/implementation-report.md

## Artifacts

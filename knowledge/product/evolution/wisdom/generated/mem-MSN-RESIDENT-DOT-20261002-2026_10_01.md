---
record_id: mem-MSN-RESIDENT-DOT-20261002-2026_10_01
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-RESIDENT-DOT-20261002-2026_10_01
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-02T00:01:42.397Z
source_branch: devin/resident-dot-autonomy-20261002
source_commit: f7f8918f875dee166693fda9af850ae08f198cb5
---

# Resident-autonomy repairs: authorize the alert path itself

Always-on operations fail silently when the reporting roles lack write scope: daemon_watchdog and chronos_gateway could not write observability/ops-alerts.jsonl, so the watchdog crashed exactly when it had something to report and the hourly health watch could not escalate. Scheduler/supervisor repairs must land authority-role card + security-policy + role-write-access scopes together.

## Hint Scope

mission

## Trigger Phrases

- When restoring autonomous operations, authorize the alert path before the daemons: (1) authority-role cards are intent, but enforcement reads security-policy.json authority_role_permissions and role-write-access.json — sync all three (sync_authority_roles regenerates the index); (2) launchd daemons resolve their role via the argv basename heuristic; (3) backups inside the scanned tree need the payload archive in the tar exclude list; (4) mission enumeration must skip role-blocked search dirs with warn+continue in both listMissionsInSearchDirs and findMissionPathAtRoot; (5) an enabled:false schedule stays opt-in-able per host via KYBERION_CHRONOS_SCHEDULES; (6) resident agents are declared via dots/ charters; new surfaces need their governed registrations in the same PR (cli-commands, vocabulary, vocabulary-keys, CLI_REFERENCE, COMPONENT_MAP, knowledge/_index).

## Recommended References

- active/missions/public/MSN-RESIDENT-DOT-20261002/evidence/distillation.md
- active/missions/public/MSN-RESIDENT-DOT-20261002/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-RESIDENT-DOT-20261002/evidence/distillation.md
- active/missions/public/MSN-RESIDENT-DOT-20261002/evidence/REVIEW-execution-implement.md

## Artifacts

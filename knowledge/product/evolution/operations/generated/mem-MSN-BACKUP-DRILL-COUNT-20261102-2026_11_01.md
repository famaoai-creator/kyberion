---
record_id: mem-MSN-BACKUP-DRILL-COUNT-20261102-2026_11_01
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-BACKUP-DRILL-COUNT-20261102-2026_11_01
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-01T23:15:48.537Z
source_branch: fix/backup-drill-count-20261102
source_commit: 1fd0ec6a73db2f537cffaea956d2bca7d65495cd
---

# Backup manifests must count only what they can see: mark credential roots tar archived under an unlisted ancestor as uncounted

When the backup role cannot list an ancestor (personal tier), tar archives the subtree itself; counts for credential roots below it are unknown, so record them uncounted and let the restore drill check presence instead of comparing against 0.

## Procedure Steps

1. In MSN-BACKUP-DRILL-COUNT-20261102 the first real restore drill failed with archived 4 / manifest 0: the backup walk could not list knowledge/personal (ROLE_VIOLATION for the backup role), so it handed the whole subtree to tar, and the manifest counted only paths the walk itself saw. Rules: (1) a manifest count is only meaningful for roots the walk fully listed; under an unlisted ancestor record uncounted (file_count 0) rather than a false 0; (2) the drill compares counts only for counted roots, keeps uncounted roots in its report, and a counted mismatch still fails; (3) count the same thing on both sides (members strictly inside the root, so an empty root is 0); (4) test the pure counting helper directly, because unlisted-directory conditions are hard to reproduce in fixtures; (5) only a real run on a real machine exposed this, after all suites were green.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-BACKUP-DRILL-COUNT-20261102/evidence/implementation-report.md
- active/missions/public/MSN-BACKUP-DRILL-COUNT-20261102/evidence/REVIEW-execution-implement.md

## Artifacts

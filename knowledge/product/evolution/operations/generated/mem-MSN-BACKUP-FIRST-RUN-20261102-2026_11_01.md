---
record_id: mem-MSN-BACKUP-FIRST-RUN-20261102-2026_11_01
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-BACKUP-FIRST-RUN-20261102-2026_11_01
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-01T21:28:07.805Z
source_branch: fix/backup-first-run-20261102
source_commit: 1659bcd1003c277868449ac59f3a2b2836d601c7
---

# First real backup: keychain access lists, guarded-root grants, and restore drills that cannot leak or delete

Keychain items must trust their reader (delete-then-add to change the list); verify ACLs on a real machine; backups decide per guarded root (exclude or narrow encrypted-only metadata grant pinned to one caller); restore drills never extract credentials, stay in scratch canonically, and delete only what they created.

## Procedure Steps

1. In MSN-BACKUP-FIRST-RUN-20261102 the first encrypted backup on a real Mac failed twice before any data moved, although every test was green.

Rules learned:

- A keychain item is readable only by the applications on its access list, and the default list is the creating executable. Kyberion wrote items through an ephemeral `swift -e` helper and read them back with /usr/bin/security, so every non-interactive read (launchd) failed with exit 128. Writers must create the item with an access list naming the reader (SecTrustedApplicationCreateFromPath + SecAccessCreate), and because an update never changes an existing item's access list, rewriting means delete then add. Trusting /usr/bin/security lets any same-user process read without a prompt — the intended trade-off for launchd; document it. Line-based stdin protocols must refuse newlines in service, account and value (security -w returns multi-line values as hex).
- Unit tests that never touch the real keychain cannot catch an access-list defect; verify once on a real machine with a throwaway item and an ACL dump, not only a read (an interactive shell may be allowed where launchd is not).
- A backup that walks guarded trees must decide per guarded root: exclude what the restore does not need (vault/secrets only names keychain entries) and admit what it does through a narrow grant — metadata-only for the walk (tar reads contents), only for an encrypted archive, non-nestable, pinned to its one caller by a boundary test, and counted in the manifest.
- Anything restored outside its original location escapes path-anchored deny rules. A restore drill must not extract credential members at all (verify their count in the archive instead), must be confined to scratch by canonical path (no symlink), must refuse a non-empty target without --force, and may delete only a target it created — a 'finally: delete target' added for hygiene turned the drill into a delete-anything command until review caught it.
- Plaintext staging (unencrypted payloads, restore dirs) needs a crash sweep keyed on exact names and an age longer than the slowest legitimate run.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-BACKUP-FIRST-RUN-20261102/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-BACKUP-FIRST-RUN-20261102/evidence/implementation-report.md
- active/missions/public/MSN-BACKUP-FIRST-RUN-20261102/evidence/test-report.md

## Artifacts

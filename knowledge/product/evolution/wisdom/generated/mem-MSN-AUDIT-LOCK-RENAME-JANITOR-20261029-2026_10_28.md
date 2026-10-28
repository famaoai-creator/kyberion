---
record_id: mem-MSN-AUDIT-LOCK-RENAME-JANITOR-20261029-2026_10_28
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-AUDIT-LOCK-RENAME-JANITOR-20261029-2026_10_28
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-28T16:23:42.087Z
source_branch: fix/audit-lock-rename-janitor-20261029
source_commit: 6daf95af1e62ad7c8868bcc99244961c2608364d
---

# Bind audit-chain grouping markers to writer-stored ids; defer audit writes raised under a non-reentrant lock

A chain entry that changes how audit records are grouped (a tenant rename's mirror-move marker) is trusted only by an audit id the governed writer stored, never by its content. A non-reentrant audit lock fails fast on reentry, and denials raised inside the locked section are audited after release.

## Hint Scope

mission

## Trigger Phrases

- - Anyone can record an audit entry with arbitrary action and metadata, so a marker that redirects records between tenants must be trusted only by an id the governed writer stored (tenant rename keeps the marker id in the profile, metadata.audit_mirror_move_ids) plus a matching step in the profile's rename history; at a trusted marker the target mirror is replaced, not merged, so an earlier owner of the slug stays out.
- Check every audit entry a multi-step change will write (auditChain.assertRecordable) before the first step, so a refused entry cannot leave the change half done.
- withAuditChainLock is not reentrant: record() inside fails at once with AUDIT_REENTRANT; secure-io denials use recordDeferrable so the denial surfaces as POLICY_BLOCKED and is audited after the lock is released; recordHeld appends at an exact point inside the lock.
- Archive an audit chain day together with every tenant mirror's same-day file under the lock, all or nothing with rollback, listing the mirrors inside the lock.
- Run strict-leak test shards in isolation: other writes in the same worktree (builds, record-evidence) are flagged as test leaks. storage-janitor.ts sits at the type-ratchet max_lines limit; extract a module instead of growing it.

## Recommended References

- active/missions/public/MSN-AUDIT-LOCK-RENAME-JANITOR-20261029/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-AUDIT-LOCK-RENAME-JANITOR-20261029/evidence/implementation-report.md
- active/missions/public/MSN-AUDIT-LOCK-RENAME-JANITOR-20261029/evidence/test-report.md
- active/missions/public/MSN-AUDIT-LOCK-RENAME-JANITOR-20261029/evidence/retrospective.md
- active/missions/public/MSN-AUDIT-LOCK-RENAME-JANITOR-20261029/evidence/distillation.md
- active/missions/public/MSN-AUDIT-LOCK-RENAME-JANITOR-20261029/evidence/design-spec.json

## Evidence

- active/missions/public/MSN-AUDIT-LOCK-RENAME-JANITOR-20261029/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-AUDIT-LOCK-RENAME-JANITOR-20261029/evidence/implementation-report.md
- active/missions/public/MSN-AUDIT-LOCK-RENAME-JANITOR-20261029/evidence/test-report.md
- active/missions/public/MSN-AUDIT-LOCK-RENAME-JANITOR-20261029/evidence/retrospective.md
- active/missions/public/MSN-AUDIT-LOCK-RENAME-JANITOR-20261029/evidence/distillation.md
- active/missions/public/MSN-AUDIT-LOCK-RENAME-JANITOR-20261029/evidence/design-spec.json

## Artifacts

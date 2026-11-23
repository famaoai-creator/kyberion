---
record_id: mem-MSN-HOLD-AUDIT-ANCHOR-20261124-2026_11_23
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-HOLD-AUDIT-ANCHOR-20261124-2026_11_23
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-23T21:54:51.502Z
source_branch: feat/hold-audit-anchor-20261124
source_commit: bb7ec217817c7d1715e00a35a46ef8a654464d4d
---

# Anchor tamper-sensitive requirements by an id the agent cannot rewrite

When a guard's requirement set is anchored in the audit chain, key the lookup by the resolved mission id (not a state field), check every pass path including machine-only, record durably after an up-front recordability check, and read the chain only at terminal checks.

## Hint Scope

mission

## Trigger Phrases

- ## Situation

Required human holds were resolved only from files the agent can write (mission state type fields, gate definition files). The fix recorded the hold set in the append-only audit chain at planning and had finish and gate-pass read it.

## Lessons

- A tamper-evident anchor only helps if its lookup key is not agent-writable. The first version keyed the audit lookup by `mission-state.json` `mission_id`, so rewriting that one field made the anchor invisible. Key by the resolved mission id (caller's id or mission directory), never by a state field.
- Enumerate every pass path of the guarded transition, not the main one. `gate-pass --machine-only` returned before the hold block; a reviewer found it. List the entry points of the transition (id path, machine-only, dispatch, phase advance) and check each.
- Record anchors durably and check recordability before the first write (`auditChain.assertRecordable`, then `recordDurable`): a silently lost anchor leaves only the weak anchors, and a refusal after partial writes leaves a half-planned mission.
- A whole-chain read (`auditChain.loadAll`) belongs only at terminal, infrequent checks (finish, gate-pass). Hot paths keep cheap local anchors; the terminal check is the backstop. Also skip the anchor work entirely for templates without holds — adding it unconditionally to planning pushed unrelated tests past their timeouts.
- Fail closed on an unreadable chain, but name the cause (chain damage vs. access scope) in the diagnostic.

## Limits

Missions planned before the anchor and audit files archived by retention have no anchor; they keep the file-based holds only.

## Recommended References

- active/missions/public/MSN-HOLD-AUDIT-ANCHOR-20261124/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-HOLD-AUDIT-ANCHOR-20261124/evidence/implementation-report.md
- active/missions/public/MSN-HOLD-AUDIT-ANCHOR-20261124/evidence/test-report.md

## Evidence

- active/missions/public/MSN-HOLD-AUDIT-ANCHOR-20261124/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-HOLD-AUDIT-ANCHOR-20261124/evidence/implementation-report.md
- active/missions/public/MSN-HOLD-AUDIT-ANCHOR-20261124/evidence/test-report.md

## Artifacts

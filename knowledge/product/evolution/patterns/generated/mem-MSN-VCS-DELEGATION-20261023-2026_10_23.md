---
record_id: mem-MSN-VCS-DELEGATION-20261023-2026_10_23
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-VCS-DELEGATION-20261023-2026_10_23
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-23T20:15:55.570Z
source_branch: feat/vcs-delegation-20261023
source_commit: 02e94cffd01dfd69568b0cd122bfdbd65e45138d
---

# Extending delegable VCS ops needs four coordinated edits

Making a vcs op charter-delegable requires: (1) delegable flag in external-vcs.ts, (2) grant union + parser in external-operation-target.ts, (3) target construction in external-operation-runtime.ts, (4) the resolver whitelist in execute(). Missing any one leaves the op silently non-delegable.

## Applicability

- mission
- mission:MSN-VCS-DELEGATION-20261023

## Reusable Steps

1. Making a vcs op charter-delegable requires: (1) delegable flag in external-vcs
2. ts, (2) grant union + parser in external-operation-target
3. ts, (3) target construction in external-operation-runtime
4. ts, (4) the resolver whitelist in execute()
5. Missing any one leaves the op silently non-delegable

## Expected Outcome

vcs:pr_merge and vcs:push were made delegable with repository+branch grant targets. ssh/git@ remote urls must be normalized before parse (grants are https-only). reputational_class distinguishes publish-grade ops (A) from PR creation (B).

## Evidence

- active/missions/public/MSN-VCS-DELEGATION-20261023/evidence/implementation-report.md
- active/missions/public/MSN-VCS-DELEGATION-20261023/evidence/distillation.md

## Artifacts

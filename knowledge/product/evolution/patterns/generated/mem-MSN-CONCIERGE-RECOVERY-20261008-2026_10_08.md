---
record_id: mem-MSN-CONCIERGE-RECOVERY-20261008-2026_10_08
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CONCIERGE-RECOVERY-20261008-2026_10_08
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-08T04:08:26.102Z
source_branch: fix/surface-interaction-consistency-20261008
source_commit: 3312df0e9effb293b3a81f315001deaea4bee84c
---

# Conversation recovery must re-verify visibility without replaying work

Use one recovery generation for visible state and asynchronous side effects, and restore drafts or retries only against the verified server-owned session.

## Applicability

- mission
- mission:MSN-CONCIERGE-RECOVERY-20261008

## Reusable Steps

1. Use one recovery generation for visible state and asynchronous side effects, and restore drafts or retries only against the verified server-owned session

## Expected Outcome

Treat a new history read, navigation, dismissal, authentication denial and scope change as trust-boundary transitions. Withdraw stale private content and actions, retire older text, metadata and voice callbacks, and classify HTTP 401 or 403 before parsing a possibly empty or HTML response. Offer sign-in for 401 and access or scope guidance for 403; a reload must remain read-only. Keep pending requests and drafts inert in session-scoped storage, and reuse the original immutable payload only on an explicit retry after the server re-verifies the same session and scope. If restored history proves the request completed, clear only its matching submitted draft, preserve a newer edit, and retain completion correlation until draft cleanup succeeds. Reset local playback and mirroring without silently invoking a remote stop or canceling server work. Test late success and denial responses, close/reopen, navigation before effects, interrupted storage cleanup, and active or delayed voice events. Mounted DOM and mocked audio tests establish client protocol behavior, not a live authenticated browser or audible playback journey.

## Evidence

- active/missions/public/MSN-CONCIERGE-RECOVERY-20261008/evidence/implementation-report.md
- active/missions/public/MSN-CONCIERGE-RECOVERY-20261008/evidence/test-report.md
- active/missions/public/MSN-CONCIERGE-RECOVERY-20261008/evidence/REVIEW-execution-implement.md

## Artifacts

---
record_id: mem-MSN-ASK-RETRY-UNCERTAINTY-20261016-2026_10_16
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-ASK-RETRY-UNCERTAINTY-20261016-2026_10_16
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-16T22:20:19.483Z
source_branch: fix/ask-retry-uncertainty-20261016
source_commit: 966ec2ee1dbc67742c5ebc50d026ace39dd09eca
---

# Keep server pending aggregates separate from local retry uncertainty

A local transport failure must not inflate an aggregate owned by server history; preserve retry identity and local errors separately.

## Applicability

- mission
- mission:MSN-ASK-RETRY-UNCERTAINTY-20261016

## Reusable Steps

1. A local transport failure must not inflate an aggregate owned by server history; preserve retry identity and local errors separately

## Expected Outcome

# Separate aggregate evidence from local uncertainty

A conversation history pending count summarizes server-owned turns. A browser transport failure does not establish that a new pending turn exists, whether it is already counted, or whether another pending request is unrelated. Do not increment, clear, or decrement that aggregate from a local POST outcome.

Keep local uncertainty in the request error and durable request identity. An explicit retry reuses the same ID and timestamp, and completion clears only matching current request state. A saved fresh response may expose its existing next action after local uncertainty resolves; replayed replies stay display-only. Preserve aggregate warnings from server history until a new scoped read supplies fresh evidence.

Regression coverage should include uncertain transport and typed responses, repeated retries, restored identities, different-text blocked submissions, aggregate counts zero and nonzero, newer composer edits, and scope or navigation changes before completion. Test the actual rendered warning and action eligibility, not just the presence of a successful reply.

## Evidence

- active/missions/public/MSN-ASK-RETRY-UNCERTAINTY-20261016/evidence/design-spec.json
- active/missions/public/MSN-ASK-RETRY-UNCERTAINTY-20261016/evidence/implementation-report.md
- active/missions/public/MSN-ASK-RETRY-UNCERTAINTY-20261016/evidence/test-report.md
- active/missions/public/MSN-ASK-RETRY-UNCERTAINTY-20261016/evidence/browser-qa.md
- active/missions/public/MSN-ASK-RETRY-UNCERTAINTY-20261016/evidence/REVIEW-execution-implement.md

## Artifacts

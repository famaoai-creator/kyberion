---
record_id: mem-MSN-PROGRESS-READ-FEEDBACK-20261013-2026_10_13
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-PROGRESS-READ-FEEDBACK-20261013-2026_10_13
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-13T04:36:21.197Z
source_branch: mission/progress-read-feedback-20261013
source_commit: 46be47164865ea71ade3af65c82a3a1f2be712a2
---

# Separate read availability from result cardinality in progress surfaces

Loading and failed reads are not evidence of an empty result. Model list availability and selected-detail availability independently while preserving scope and latest-response guards.

## Applicability

- mission
- mission:MSN-PROGRESS-READ-FEEDBACK-20261013

## Reusable Steps

1. Loading and failed reads are not evidence of an empty result
2. Model list availability and selected-detail availability independently while preserving scope and latest-response guards

## Expected Outcome

## When to apply
Use this pattern for asynchronous progress, request, or result views where an empty collection is a meaningful claim and a selected row starts a separate detail read.

## State and safety rules
- Show counts and empty-result guidance only after a successful current-scope list read. Before that, use count-free labels and an explicit checking or failure message.
- Distinguish a pending selected detail from no selection. Name the selected item in loading, failure and ready feedback so request-to-result continuity remains visible.
- Keep existing fail-closed clearing behavior for uncertain scope, refresh failures and authorization-sensitive responses. Improving feedback must not make stale protected rows or actions newly usable.
- Fence every response by request generation and current selection. Clear or replace status feedback when newer navigation wins.
- A retry should repeat only the failed read for the current selection. Guard repeated activation while pending and keep execution/approval conditions independent of read state.

## Accessible presentation
Keep persistent status live regions mounted, including while empty, and outside payload containers marked aria-busy. Use busy state for the content being replaced. Verify that keyboard users can activate retry, recognize pending state and reach the recovered content without a focus trap.

## Verification
Use deferred-response tests for initial pending, verified empty, read failure, retry, repeated activation, selection A-to-B-to-A and filter changes during an outstanding read. Preserve authorization-clearing and decision-lock regression tests. Inspect the actual component in a clearly labelled synthetic read fixture for slow/error cases, languages and narrow layouts; separately state real-app, network-count and screen-reader coverage limits.

## Evidence

- active/missions/public/MSN-PROGRESS-READ-FEEDBACK-20261013/evidence/implementation-report.md
- active/missions/public/MSN-PROGRESS-READ-FEEDBACK-20261013/evidence/test-report.md
- active/missions/public/MSN-PROGRESS-READ-FEEDBACK-20261013/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-PROGRESS-READ-FEEDBACK-20261013/evidence/REVIEW-contract_authoring-ux-contract.md

## Artifacts

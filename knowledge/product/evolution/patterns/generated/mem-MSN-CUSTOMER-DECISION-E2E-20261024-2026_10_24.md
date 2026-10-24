---
record_id: mem-MSN-CUSTOMER-DECISION-E2E-20261024-2026_10_24
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CUSTOMER-DECISION-E2E-20261024-2026_10_24
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-24T13:46:39.330Z
source_branch: fix/customer-decision-e2e-20261024
source_commit: 41308ddcd5da6dff41b60cd87b18cebc6705887b
---

# Customer-facing features: one human-in-the-loop E2E on a registered tenant before done

A live end-to-end run with real human approvals on a registered demo tenant found a critical authority defect and a customer-visible layout break that unit tests, independent reviews and agent live checks had missed.

## Applicability

- mission
- mission:MSN-CUSTOMER-DECISION-E2E-20261024

## Reusable Steps

1. A live end-to-end run with real human approvals on a registered demo tenant found a critical authority defect and a customer-visible layout break that unit tests, independent reviews and agent live checks had missed

## Expected Outcome

Applies before calling a customer-facing Kyberion feature done.

1. Run one end-to-end pass on a registered (tenant-scoped, confidential) demo tenant with real human approvals: agents cannot give human-only approvals, so agent-only live checks never exercise the send path.
2. Build test fixtures with a confidential tenant whenever production data is tenant-scoped; tenant-less fixtures hid that finished tenant missions are unreadable without the right authority.
3. Never turn a permission denial into "not found": surface it with a distinct error and a diagnostic warn, or authority bugs stay invisible.
4. Look at every customer-visible screen at phone width with the real server, including receipts and state screens after submit; kit components may assume structure (e.g. a callout content wrapper) that unit tests do not check.
5. Keep internal process words (bolt, mission) out of customer-facing text.
6. Remove demo data through the governed facades (tenant archive + delete --purge-data) and keep the rest inside a disposable worktree.

## Evidence

- active/missions/public/MSN-CUSTOMER-DECISION-E2E-20261024/evidence/e2e-report.md
- active/missions/public/MSN-CUSTOMER-DECISION-E2E-20261024/evidence/retrospective.md
- active/missions/public/MSN-CUSTOMER-DECISION-E2E-20261024/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-CUSTOMER-DECISION-E2E-20261024/evidence/test-report.md

## Artifacts

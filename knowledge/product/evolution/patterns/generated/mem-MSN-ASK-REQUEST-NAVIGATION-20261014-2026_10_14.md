---
record_id: mem-MSN-ASK-REQUEST-NAVIGATION-20261014-2026_10_14
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-ASK-REQUEST-NAVIGATION-20261014-2026_10_14
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-14T12:12:25.923Z
source_branch: fix/ask-request-navigation-20261014
source_commit: f502ccbe99cdced97de9112cacb38b43c8893b72
---

# Navigate from conversation turns using durable references and positive scoped evidence

A conversation message ID is not evidence of tracked work. Build read-only navigation from durable request routing and positively matched scoped execution records, and retire rendered links when scope changes.

## Applicability

- mission
- mission:MSN-ASK-REQUEST-NAVIGATION-20261014

## Reusable Steps

1. A conversation message ID is not evidence of tracked work
2. Build read-only navigation from durable request routing and positively matched scoped execution records, and retire rendered links when scope changes

## Expected Outcome

## When to apply
Use this pattern when a conversational interface offers links from user turns to earlier requests or execution detail.

## Procedure
1. Project inert original-request references only from durable intake routing in the authorized conversation partition. A status question or follow-up has its own message ID but may target an earlier request. Never infer a destination from model prose or response shape.
2. Build a single permission-filtered execution-session map for each response. An explicit correlation match may provide an exact detail link even for legacy conversation turns without intake routing. Missing matches or read failures establish no execution outcome.
3. Without an execution match, link only to a different original request whose user message survives the final returned-history slice, including appended execution reports. Suppress self-links and unavailable targets; preserve ambiguous retained candidates rather than choosing one.
4. Keep navigation display-only. Validate bounded metadata and construct local URLs through the existing scope helper. The destination must recheck authorization and current availability. Navigation never approves, retries or marks work complete.
5. Bind live and restored links to the current scope snapshot and shell epoch. On scope retirement, remove already-rendered links immediately, not only on the next eventual render. Keep transport retry identity untouched.

## Verification
Test greetings, direct replies, status/follow-up targets, legacy positive correlations, multiple candidates, final history truncation, scope mismatch and stale responses, optional source failure, malformed metadata, immediate DOM retirement and pending identity preservation. Reproduce with the actual renderer and label synthetic transport separately from real provider execution.

## Evidence

- active/missions/public/MSN-ASK-REQUEST-NAVIGATION-20261014/evidence/implementation-report.md
- active/missions/public/MSN-ASK-REQUEST-NAVIGATION-20261014/evidence/test-report.md
- active/missions/public/MSN-ASK-REQUEST-NAVIGATION-20261014/evidence/browser-qa.json
- active/missions/public/MSN-ASK-REQUEST-NAVIGATION-20261014/evidence/REVIEW-execution-implement.md

## Artifacts

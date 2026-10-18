---
record_id: mem-MSN-PITCH-RESULT-20261018-2026_10_18
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-PITCH-RESULT-20261018-2026_10_18
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-18T10:29:01.071Z
source_branch: fix/pitch-result-journey-20261018
source_commit: 1916f345094bdeb239536a1bb7c2c99335d849a0
---

# Bound mutation response waits without inventing an outcome

A stalled mutation response must not permanently block read-only recovery. Bound headers and JSON parsing, retain exact pending identity and outcome uncertainty, and discard late original callbacks without automatic replay.

## Applicability

- mission
- mission:MSN-PITCH-RESULT-20261018

## Reusable Steps

1. A stalled mutation response must not permanently block read-only recovery
2. Bound headers and JSON parsing, retain exact pending identity and outcome uncertainty, and discard late original callbacks without automatic replay

## Expected Outcome

## Rule

A browser response deadline limits the UI wait, not the server effect. Missing headers, an unfinished JSON body, a network error or a late response cannot prove cancellation, failure or safe replay. Keep the original operation identity and no-resend guard while allowing explicit authorized reads. Missing or unrelated read results do not prove nonexecution.

## Procedure

Wrap both fetch and response-body parsing in one bounded promise. State callbacks must observe that promise only, so a late original response cannot publish success after uncertainty or overwrite a newer read or access-loss state. Clear the deadline after timely settlement. Do not use mutation abort as proof of cancellation, introduce automatic retries, or invoke an execution tick from read-only refresh. Reuse the same semantics for related approval and recovery controls while preserving their current generation and authentication checks.

For intake, retain the exact stored request with retrySafe false until the existing authoritative read model reconciles it. For decisions, require a fresh authorized view before any further explicit action. A read is observation, not an implicit decision or execution permission.

## Regression gate

Exercise initial and revised intake plus approve and reject, with both stalled fetch and stalled JSON. Verify the deadline boundary, timely cleanup, duplicate clicks, exact pending identity, no automatic replay, explicit refresh, late responses and newer signed-out state. Test parent and approval controls together so both regain read-only refresh.

The first-job change reproduced eight failing pre-fix cases and passed 2006 Presence tests, 218 diagnostic tests, full build, typecheck, lint, formatting and 48 PR gates. Independent source/report review found no blocking findings.

## Evidence boundary

Synthetic client and controlled-store tests do not establish rendered-browser operation, real OIDC/member identity, human approval or live request-to-artifact execution. Report these separately. The existing first-job flow is a fixed public diagnostic receipt, not general autonomous report generation. A separate provider experiment failed at startup and produced no answer; it is not success evidence.

## Evidence

- active/missions/public/MSN-PITCH-RESULT-20261018/evidence/implementation-report.md
- active/missions/public/MSN-PITCH-RESULT-20261018/evidence/test-report.md
- active/missions/public/MSN-PITCH-RESULT-20261018/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-PITCH-RESULT-20261018/evidence/demo-checklist.md

## Artifacts

---
record_id: mem-MSN-PROGRESS-REVISION-CONTINUITY-20261013-2026_10_13
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-PROGRESS-REVISION-CONTINUITY-20261013-2026_10_13
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-13T12:45:47.888Z
source_branch: fix/progress-revision-continuity-20261013
source_commit: 42327418321c711fa6e2f99335b0862eaaba7cf0
---

# Keep correction drafts scoped and separate feedback recording from execution

Preserve correction text outside transient rendering, bind continuation reads to the verified current principal, and require explicit review before dispatch.

## Applicability

- mission
- mission:MSN-PROGRESS-REVISION-CONTINUITY-20261013

## Reusable Steps

1. Preserve correction text outside transient rendering, bind continuation reads to the verified current principal, and require explicit review before dispatch

## Expected Outcome

Apply this pattern when a result-feedback surface prepares a later conversational request. Keep unsent correction text outside DOM render state, keyed by the server-verified viewer and exact result entry. Preserve drafts through selection, filtering, same-page history navigation, and failed reads; clear only the exact confirmed submission, an explicit discard, or a verified viewer/scope change. Do not add persistent note storage merely to survive re-rendering. A feedback-recording response is not evidence that revision work started. Offer a truthful recorded state and an explicit preparation action. Carry only identifiers in navigation URLs. Resolve the saved note with the current authenticated viewer, independently authorize both result and feedback records, verify their exact relationship, and return no content on denied or stale identities. Bind the client read and delayed draft acceptance to the same verified history identity and scope generation. Require explicit draft conflict choice and an explicit send; suppress automatic URL execution flags on the preparation route. Preserve the full note even when identity context makes the composed request exceed its send limit, and explain the required edit instead of truncating. Validate browser-native controls with actual HTML: a single-line input strips newline characters even when a simple DOM test double retains them. Use a multiline control, preserve its established submit semantics, and cover IME, Shift+Enter, voice, prefills, and send limits. Report synthetic fixture boundaries honestly; a blocked fixture POST proves no backend effect, not that no POST was attempted.

## Evidence

- active/missions/public/MSN-PROGRESS-REVISION-CONTINUITY-20261013/evidence/implementation-report.md
- active/missions/public/MSN-PROGRESS-REVISION-CONTINUITY-20261013/evidence/test-report.md
- active/missions/public/MSN-PROGRESS-REVISION-CONTINUITY-20261013/evidence/browser-discovery.md
- active/missions/public/MSN-PROGRESS-REVISION-CONTINUITY-20261013/evidence/REVIEW-execution-implement.md

## Artifacts

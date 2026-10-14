---
record_id: mem-MSN-HOME-ASK-DRAFT-20261014-2026_10_14
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-HOME-ASK-DRAFT-20261014-2026_10_14
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-14T04:15:41.876Z
source_branch: fix/home-ask-draft-preservation-20261014
source_commit: ff5c369f69ccb8469318c18b5fc68dc7ad6fae2b
---

# Keep composer ownership separate from transport retry identity

A cross-page explicit send should preserve an unrelated draft and any unresolved retry identity without adding routine confirmation or another persistence store.

## Applicability

- mission
- mission:MSN-HOME-ASK-DRAFT-20261014

## Reusable Steps

1. A cross-page explicit send should preserve an unrelated draft and any unresolved retry identity without adding routine confirmation or another persistence store

## Expected Outcome

## When to apply
Use this pattern for a conversational composer receiving an explicit request from another page while it may already hold an unsent draft or unresolved request.

## Procedure
1. Treat composer text and transport request metadata as separate existing records. Sending new handoff text does not imply ownership of the older composer. Clear input only when the completed request owned it and no later edit occurred.
2. Re-read the durable request metadata before every send path. Reuse its ID and timestamp for same-text retries; block different text while the earlier outcome is unresolved. Keep blocked handoff text reviewable, but remove automatic-send instructions from the URL.
3. Offer review of a submitted request through the existing draft replacement choice. Review and acceptance never send. Recheck the durable request ID/text/timestamp, server-issued conversation key, current scope and shell epoch before accepting a deferred choice.
4. Capture history-read context before the asynchronous GET. Reject a stale response before restoring text or enabling recovery. Reading under a new scope must not legitimize old-scope data.
5. During history recovery, retire saved retry metadata only when authoritative current history contains the exact matching user request and its completed reply. Incomplete history retains the identity; failed or silently dropped cleanup fails closed. Preserve composer text even when equal, because text equality alone does not establish ownership.

## Verification
Cover explicit handoff success/failure, early or concurrent typing/clearing, reload without resending, same-ID retry, conflicting manual sends, changed durable metadata, interrupted history reads, scope changes, and throwing or silent storage failures. Use the actual renderer with labelled synthetic transport for visual checks; distinguish that from authenticated provider execution.

## Evidence

- active/missions/public/MSN-HOME-ASK-DRAFT-20261014/evidence/implementation-report.md
- active/missions/public/MSN-HOME-ASK-DRAFT-20261014/evidence/test-report.md
- active/missions/public/MSN-HOME-ASK-DRAFT-20261014/evidence/browser-diagnostic.md
- active/missions/public/MSN-HOME-ASK-DRAFT-20261014/evidence/REVIEW-execution-implement.md

## Artifacts

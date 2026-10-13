---
record_id: mem-MSN-ASK-HISTORY-RECOVERY-20261013-2026_10_13
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-ASK-HISTORY-RECOVERY-20261013-2026_10_13
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-13T11:16:16.369Z
source_branch: fix/ask-history-recovery-20261013
source_commit: 72a82aeaaff7b0fdc10b668e8671d01a9e8df096
---

# Resume conversation actions only after verified history recovery

Conversation recovery must settle critical reads, ignore stale completions, and activate URL handoffs only after current history and local request storage are verified.

## Applicability

- mission
- mission:MSN-ASK-HISTORY-RECOVERY-20261013

## Reusable Steps

1. Conversation recovery must settle critical reads, ignore stale completions, and activate URL handoffs only after current history and local request storage are verified

## Expected Outcome

A usable Retry button is insufficient when an earlier history read can finish after the retry and overwrite its result. Bound each read-only history request across headers and body consumption with a promise deadline that settles even if abort is unavailable or ignored. Preserve non-success status from the headers without waiting for an irrelevant error body, so 401/403 still reach access guidance. Keep history read ownership explicit: guard result and failure continuations with a generation, disable and handler-guard Retry during a pending read, and avoid starting a history refresh while a reply POST is outstanding. Extract cohesive read recovery when the main page script is already large. A failed history read must not resolve as permission to consume dependent URL actions. Apply prefill, explicit-send handoff and microphone handoff only after the current history and saved request metadata have been verified; retain the URL on failure or storage corruption. Preserve early draft edits, deliberate clearing and pending request identity. Leave mutation transport and unknown-outcome handling separate: this read deadline must never introduce automatic POST retries. Regression evidence should include stalled headers and JSON, repeated Retry, late success and denial after recovery, corrupt stored metadata, URL handoff gating, and a POST already in flight. Use actual current HTML/JS in a labelled GET-only synthetic browser adapter to verify visible loading, failure, retry and draft continuity; distinguish that client evidence from production/backend authorization and microphone or provider coverage.

## Evidence

- active/missions/public/MSN-ASK-HISTORY-RECOVERY-20261013/evidence/distillation.md
- active/missions/public/MSN-ASK-HISTORY-RECOVERY-20261013/evidence/browser-verification.md

## Artifacts

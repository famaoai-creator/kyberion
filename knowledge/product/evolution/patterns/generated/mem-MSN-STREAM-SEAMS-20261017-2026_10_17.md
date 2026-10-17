---
record_id: mem-MSN-STREAM-SEAMS-20261017-2026_10_17
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-STREAM-SEAMS-20261017-2026_10_17
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-17T11:49:38.400Z
source_branch: fix/streaming-seam-lifecycle-20261017
source_commit: 654e0e69a9b54611dbe0ff04783f52cbb41066a2
---

# Streaming seams must drain output and preserve execution requirements

Complete subprocess output before success, propagate partial-stream failure, and carry language from selection to execution.

## Applicability

- mission
- mission:MSN-STREAM-SEAMS-20261017

## Reusable Steps

1. Complete subprocess output before success, propagate partial-stream failure, and carry language from selection to execution

## Expected Outcome

For subprocess-backed streaming STT/TTS, child exit is not stdout EOF. Observe close, drain queued output on normal completion, and reject consumers on worker, spawn or input-source failure, including consumers waiting for their next chunk. A partial final transcript does not make a failed stream successful: propagate the failure to the batch fallback and observe early promise rejections. Pass language per transcription through normal, replay, barge-in and calibration paths; normalize it only at the worker boundary without changing process-wide environment. Verify with real subprocess fixtures, slow consumers and final-then-failure recovery tests.

## Evidence

- active/missions/public/MSN-STREAM-SEAMS-20261017/evidence/implementation-report.md
- active/missions/public/MSN-STREAM-SEAMS-20261017/evidence/test-report.md
- active/missions/public/MSN-STREAM-SEAMS-20261017/evidence/REVIEW-execution-implement.md

## Artifacts

---
record_id: mem-MSN-COSESSION-HOOKS-20261018-2026_10_18
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-COSESSION-HOOKS-20261018-2026_10_18
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-18T04:43:20.329Z
source_branch: feat/codex-co-session-hooks-20261018
source_commit: 22030878354a8174dd02903020ca98fb189df9b8
---

# Loop-safe Co-Session hook delivery

Use safe event boundaries, telemetry-only Stop hooks, and serialized per-participant receipts to prevent cross-CLI notification loops.

## Hint Scope

mission

## Trigger Phrases

- Co-Session hooks should join on SessionStart, pull new handoffs on user input and supported tool completion, and release leases only on SessionEnd. Stop must not emit continuation instructions; skip recursive Stop invocations before telemetry. Persist delivery receipts separately from explicit acknowledgements. Read pending handoffs inside the same lock as receipt updates: an outside snapshot can erase a newer delivery receipt and cause repeats. Suppress self messages, preserve user hook commands during regeneration, and let native CLI trust control activation. Delivery remains best-effort, so the pending handoff list is canonical. Validate repeated events, concurrent delivery interleavings, batch overflow, separate CLI instances, and compiled hook stdout. Run test leak checks without concurrent owner evidence writes.

## Recommended References

- active/missions/public/MSN-COSESSION-HOOKS-20261018/evidence/test-report.md
- active/missions/public/MSN-COSESSION-HOOKS-20261018/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-COSESSION-HOOKS-20261018/evidence/test-report.md
- active/missions/public/MSN-COSESSION-HOOKS-20261018/evidence/REVIEW-execution-implement.md

## Artifacts

---
record_id: mem-MSN-SCOPE-VALIDATION-REPAIR-20261106-2026_11_05
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-SCOPE-VALIDATION-REPAIR-20261106-2026_11_05
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-06T01:25:31.099Z
source_branch: feat/scope-independent-resolution-20261106
source_commit: 509a7c34898f84331b1f94db044a293a2af1b254
---

# Isolate real-policy storage fixtures before imports

Use owned selected and primary roots, preserve real authorization, and isolate process-global audit state.

## Applicability

- mission
- mission:MSN-SCOPE-VALIDATION-REPAIR-20261106

## Reusable Steps

1. Use owned selected and primary roots, preserve real authorization, and isolate process-global audit state

## Expected Outcome

Storage boundary tests should create an owned scratch checkout with real product policies and schemas, set root environment before importing the heavy I/O stack, and assert selected and primary roots. Initialize once per file; reset per-case owned state without rebuilding the full authority stack. Module resets alone do not replace a process-global audit singleton: save and restore its exact descriptor around the fixture. Scan all owned public runtime, scratch and mission outputs rather than parallel suites' checkouts. Keep real issuers/schema validation and restore inherited provider-selection environment. Copy regenerable fixture inputs with guarded copy APIs; do not increase timeouts or weaken authorization to hide setup costs. See operations-hygiene-runbook section 5.

## Evidence

- active/missions/public/MSN-SCOPE-VALIDATION-REPAIR-20261106/evidence/implementation-report.md
- active/missions/public/MSN-SCOPE-VALIDATION-REPAIR-20261106/evidence/test-report.md

## Artifacts

---
record_id: mem-MSN-DOT-SCHEDULING-CURSOR-20261011-2026_10_11
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-DOT-SCHEDULING-CURSOR-20261011-2026_10_11
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-11T22:49:34.716Z
source_branch: fix/dot-scheduling-cursor-validation
source_commit: 9fbaba6b835e27b4d721958bc396e5beb2560887
---

# Distinguish absent scheduling state from corrupt continuation evidence

Durable continuation readers must initialize only on proven absence and preserve malformed or inaccessible evidence before scheduling and recording turns.

## Applicability

- mission
- mission:MSN-DOT-SCHEDULING-CURSOR-20261011

## Reusable Steps

1. Durable continuation readers must initialize only on proven absence and preserve malformed or inaccessible evidence before scheduling and recording turns

## Expected Outcome

When a durable cursor determines fair scheduling, use a local strict reader: classify only an initial governed ENOENT metadata result as absence, then validate a regular file through the shared JSON reader and pure shape predicate. Reject parsing, access, metadata and subsequent read failures, including falsy JSON and disappearance after existence was observed. Preserve the original evidence and require operator inspection; an optional reader that returns null on all errors silently resets scheduling. Reuse the same semantics in read-only diagnostics, sanitize errors, and revalidate under the existing recording lock because ordering and recording may be separated. This is not filesystem compare-and-swap against noncooperating writers. Validate actual isolated effects, attempts, byte preservation and fresh-process fairness; normalize fault-injection paths with path.join for Windows portability. Keep authenticated recovery and scoped execution policy separate from cursor blockage.

## Evidence

- active/missions/public/MSN-DOT-SCHEDULING-CURSOR-20261011/evidence/test-report.md
- active/missions/public/MSN-DOT-SCHEDULING-CURSOR-20261011/evidence/REVIEW-execution-implement.md

## Artifacts

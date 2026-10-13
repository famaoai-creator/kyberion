---
record_id: mem-MSN-CHECK-RUNNER-CONCURRENCY-20261013-2026_10_13
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CHECK-RUNNER-CONCURRENCY-20261013-2026_10_13
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-13T19:37:18.827Z
source_branch: fix/check-runner-concurrency-20261013
source_commit: c62c9b176b219c0666e52af1623646952fac3cf9
---

# Bound check concurrency without weakening validation

Use explicit bounded concurrency to reduce resource contention while preserving the complete gate set, failure evidence and publication readiness.

## Applicability

- mission
- mission:MSN-CHECK-RUNNER-CONCURRENCY-20261013

## Reusable Steps

1. Use explicit bounded concurrency to reduce resource contention while preserving the complete gate set, failure evidence and publication readiness

## Expected Outcome

# Bounded check concurrency

When isolated validation succeeds but a concurrent aggregate is unstable, reduce scheduling pressure rather than remove gates or raise global budgets. Use pnpm check -- --scope pr --jobs 1 on constrained hosts; supported values are integers 1–6 and omission retains 6.

Preserve gate selection, per-gate timeouts, secure child environments, package-manager serialization, manifest-order reporting and nonzero failure propagation. Reject malformed, missing, out-of-range and duplicate values before launching checks. Differential tests should compare default/serial scheduling, exactly-once command execution, stable reports and both numeric and resource-terminated failures; test hosted markers separately from global environment inheritance.

Forward the same bound through the actual publication path with --check-jobs 1. A prior isolated pass never substitutes for the complete readiness rerun. Keep genuine failure results visible: even an unrelated fragment metadata error must fail the aggregate while retaining every selected result.

Before publication, validate the exact clean code head and body; after any source/base change, rebuild affected outputs and rerun readiness. Curated public lessons ship with the verified code, while raw lifecycle and private profile data remain outside the public diff.

## Evidence

- active/missions/public/MSN-CHECK-RUNNER-CONCURRENCY-20261013/evidence/test-report.md
- active/missions/public/MSN-CHECK-RUNNER-CONCURRENCY-20261013/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-CHECK-RUNNER-CONCURRENCY-20261013/evidence/serial-pr48-corrected.json
- active/missions/public/MSN-CHECK-RUNNER-CONCURRENCY-20261013/evidence/serial-pr48-first.json

## Artifacts

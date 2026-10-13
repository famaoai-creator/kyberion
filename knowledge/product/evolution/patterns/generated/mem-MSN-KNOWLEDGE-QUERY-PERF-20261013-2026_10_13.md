---
record_id: mem-MSN-KNOWLEDGE-QUERY-PERF-20261013-2026_10_13
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-KNOWLEDGE-QUERY-PERF-20261013-2026_10_13
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-13T06:07:38.286Z
source_branch: mission/knowledge-query-perf-20261013
source_commit: 300a17b3ce634c4574f0b1c86d7d660edc960121
---

# Bound query ranking work before relaxing latency budgets

Memoize expensive ranking metadata per query and test operation counts alongside unchanged latency budgets.

## Applicability

- mission
- mission:MSN-KNOWLEDGE-QUERY-PERF-20261013

## Reusable Steps

1. Memoize expensive ranking metadata per query and test operation counts alongside unchanged latency budgets

## Expected Outcome

When a lexical query breaks score ties with metadata, avoid repeated settings reads and metadata evaluation inside the sort comparator. Use a query-local cache keyed by hint identity, load scoped weights lazily once, and use one query-local time snapshot. Treat zero as a cached value. Do not reuse scores or weights between requests: same-scope settings can change. Preserve stable equal-score ordering, lexical priority, duplicate-source hint identity, chunk aggregation, score annotations, and input immutability. Keep no-match, singleton, and distinct-score paths lazy. Add deterministic call-count regressions and scope-refresh tests while retaining the existing wall-clock budget. A successful retry establishes intermittency, not the absence of wasted work. Keep sandbox IPC failures, resource termination, and accidentally forced provider test settings separate from product regressions; validate dependent groups in the normal CI environment and require exact-commit hosted CI.

## Evidence

- active/missions/public/MSN-KNOWLEDGE-QUERY-PERF-20261013/evidence/implementation-report.md
- active/missions/public/MSN-KNOWLEDGE-QUERY-PERF-20261013/evidence/test-report.md
- active/missions/public/MSN-KNOWLEDGE-QUERY-PERF-20261013/evidence/independent-review-report.md

## Artifacts

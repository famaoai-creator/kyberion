---
record_id: mem-MSN-HOOK-LEDGER-REPAIR-20261018-2026_10_18
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-HOOK-LEDGER-REPAIR-20261018-2026_10_18
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-18T09:49:05.335Z
source_branch: fix/workflow-reuse-hook-ledger-20261018
source_commit: 146e0da3b92df2a177a76434afdd53095fcd301e
---

# Keep mutable mission receipts and hook startup consistent through interruptions

Mission ledger and task mutations must refresh durable receipts under the writer mutex, and replay must read the same snapshot. Provider policy hooks need a build-independent entrypoint.

## Applicability

- mission
- mission:MSN-HOOK-LEDGER-REPAIR-20261018

## Reusable Steps

1. Mission ledger and task mutations must refresh durable receipts under the writer mutex, and replay must read the same snapshot
2. Provider policy hooks need a build-independent entrypoint

## Expected Outcome

Applicability: mission artifact writers, replay/recovery readers and provider hook wiring.

Append ledger bytes and their provisioned/verified receipt under the same fenced writer lease. Read the journal, receipt and target hashes under that mutex without modifying the fence. Refresh NEXT_TASKS receipts through the canonical writer on every task transition. Validate newly appended rows before persisting their intent. Avoid a create-if-missing check followed by truncating initialization outside the lock.

For the legacy writer that receipted only an empty ledger, migrate only the known matching initial receipt pair after validating complete same-mission JSONL. Preserve every historical byte and receipt; record that old appends cannot be retroactively authenticated. Refuse other corruption. Refresh legacy task receipts through real evidence/review actions rather than editing task statuses.

Build cleanup can remove a hook entrypoint or its dependencies. Use a dependency-free launcher; unavailable notification hooks emit a bounded diagnostic, while unavailable tool-authorization hooks deny. Preserve runner output and exit semantics once loaded. Regression tests should cover competing initialization, invalid new rows, interrupted writes, read/write overlap, missing hook dependencies and both Claude policy aliases.

## Evidence

- active/missions/public/MSN-HOOK-LEDGER-REPAIR-20261018/evidence/implementation-report.md
- active/missions/public/MSN-HOOK-LEDGER-REPAIR-20261018/evidence/ledger-recovery.json
- active/missions/public/MSN-HOOK-LEDGER-REPAIR-20261018/evidence/REVIEW-execution-implement.md

## Artifacts

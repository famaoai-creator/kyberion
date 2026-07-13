---
title: "Adopting Verified Work Into Mission Tasks"
category: Engineering
tags: ["mission", "task-contract", "evidence", "reconciliation"]
importance: 7
source_mission: MSN-RECONCILE-EXISTING-WORK-20260713
author: Kyberion Wisdom Distiller
last_updated: 2026-07-13
---

# Adopting Verified Work Into Mission Tasks

## Summary
Mission tasks and Mission Evidence are separate contracts. Work completed on a
feature branch before `dispatch-workitems` must not remain permanently
`planned`, but Evidence presence alone must not bypass the finish exit gate.

## Key Learnings
- Normal work should continue through `dispatch-tickets` and
  `dispatch-workitems`; reconciliation is an explicit exception path.
- Safe adoption requires exact task IDs, source branch and commit, SHA-256
  Evidence, proof that Evidence is tracked unchanged by that commit, complete
  acceptance-criterion mappings, passed verification records, resolved
  dependencies, and execution-actor binding.
- `record-evidence` should remain non-mutating for `NEXT_TASKS.json`. Combining
  evidence recording with task completion would let partial or unrelated proof
  bypass the exit gate.
- A dry-run must use the complete preflight but perform no Mission, WorkItem,
  ledger, receipt, or audit mutation.

## Patterns Discovered
- Bind an adoption receipt to a commit in the repository that owns the
  Evidence. The receipt may reference a separate implementation commit while
  remaining immutable itself.
- Update local WorkItems as a projection of accepted Mission task state, but do
  not close GitHub or Jira tickets from the reconciliation path.
- Generated `repair-finish-exit` work may be completed automatically only when
  all of its dependencies are terminal.
- Idempotence includes append-only stores: repeated application of the same
  manifest must not duplicate ledger/audit events or rewrite receipt
  timestamps.
- Completion reconciliation uses structural text matching. Preserve a
  top-level Evidence artifact containing the approved success condition in
  exact form when the condition is a compound sentence.

## Failures & Recoveries
- The first implementation required SUDO, which was stronger than Mission
  lifecycle ownership requires. The boundary was narrowed to
  `mission_controller` role or explicit SUDO.
- The first full validation exposed avoidable `any` casts through type-ratchet.
  The casts were removed; only new source/test file counts were rebaselined.
- The first repeated real application left task statuses unchanged but
  duplicated ledger entries and rewrote the receipt. A no-mutation early return
  was added and verified against stable receipt hash and ledger count.
- The generic development Mission lacked the actual user goal, so the goal loop
  generated a circular lifecycle-completion gap. The operator rebaselined scope
  to the explicit PR outcome before final verification.
- A failed finish committed the Mission repo before an invalid
  `validating -> completed` transition, leaving `latest_commit` stale. The
  standard evidence command resynchronized the pointer before retrying.
- LLM distillation could not run because the bundled Codex binary was missing
  and the installed Gemini client was ineligible. Structural fallback completed,
  then this document was manually reviewed and corrected.

---
*Distilled by Kyberion | Mission: MSN-RECONCILE-EXISTING-WORK-20260713 | 2026-07-13*

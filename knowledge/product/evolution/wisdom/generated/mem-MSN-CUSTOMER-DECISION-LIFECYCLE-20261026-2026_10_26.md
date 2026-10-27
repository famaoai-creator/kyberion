---
record_id: mem-MSN-CUSTOMER-DECISION-LIFECYCLE-20261026-2026_10_26
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CUSTOMER-DECISION-LIFECYCLE-20261026-2026_10_26
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-26T00:23:45.181Z
source_branch: feat/customer-decision-lifecycle-followups-20261026
source_commit: 642ba72d57a4a3ebe23ecf74743d508de51ed46e
---

# Human-gated task supersede and re-ask: prove the closure, make every step resumable, guard every board writer

A status or lock mark that releases holds or lets a mission finish must be provable from an approved, human-authenticated request bound to the exact effect plus apply evidence; authority-granting readers require the proof, nothing completes a superseded task, multi-step effects resume only from a first-written receipt, and background board writers merge rather than overwrite.

## Hint Scope

mission

## Trigger Phrases

- ## Context

Customer-decision follow-ups: re-ask an unresolvable question, approval-gated `mission_controller supersede-task`, pin-failure escalation, hourly reminders, a task-decisions read verb. Review needed three rounds; the first was NO-GO.

## Lessons

1. A shape-only guard on a 'closed' marker is a bypass of the human gate: a worker could mark its own lock superseded and release its hold. Honour the marker only through a proof that reads an approved mission_gate request (authenticated human decision, effect binding, payload hash) plus evidence that apply ran.
2. Authority-granting readers (finish gate, auto-complete, cascade, continuous owner) require the proof; display readers may show the bare status; nothing may ever complete a superseded task, proven or not — fail closed means neither closed nor completable.
3. Multi-step governed effects: write a receipt first under the lock, derive 'resume' only from it, make every later step idempotent (audit keyed by approval), write the shared board last, and check approval expiry only at start so a crash is repairable.
4. Background writers of a shared task board must merge with the on-disk copy: keep supersede records and recorded dependency rewrites, never introduce a closing status, and keep tasks they did not load.
5. A transition only a facade may perform (re-ask relink) needs a facade-written marker in a store workers cannot write, which the guard requires; facade and guard must share one predicate and the facade must run the guard check before writing.
6. Pin-failure counters on records whose metadata is replaced wholesale must be carried forward explicitly.

## How to apply

For any new verb that closes, skips or releases mission work, add a proof helper and route only authority-granting readers through it; add a forged-state test (worker writes the status/mark directly) for each.

## Recommended References

- active/missions/public/MSN-CUSTOMER-DECISION-LIFECYCLE-20261026/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-CUSTOMER-DECISION-LIFECYCLE-20261026/evidence/implementation-report.md
- active/missions/public/MSN-CUSTOMER-DECISION-LIFECYCLE-20261026/evidence/retrospective.md
- active/missions/public/MSN-CUSTOMER-DECISION-LIFECYCLE-20261026/evidence/design-spec.json
- active/missions/public/MSN-CUSTOMER-DECISION-LIFECYCLE-20261026/evidence/test-report.md

## Evidence

- active/missions/public/MSN-CUSTOMER-DECISION-LIFECYCLE-20261026/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-CUSTOMER-DECISION-LIFECYCLE-20261026/evidence/implementation-report.md
- active/missions/public/MSN-CUSTOMER-DECISION-LIFECYCLE-20261026/evidence/retrospective.md
- active/missions/public/MSN-CUSTOMER-DECISION-LIFECYCLE-20261026/evidence/design-spec.json
- active/missions/public/MSN-CUSTOMER-DECISION-LIFECYCLE-20261026/evidence/test-report.md

## Artifacts

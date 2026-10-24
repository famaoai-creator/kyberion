---
record_id: mem-MSN-CUSTOMER-DECISION-CD09-20261024-2026_10_24
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CUSTOMER-DECISION-CD09-20261024-2026_10_24
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-24T07:26:08.556Z
source_branch: feat/customer-decision-cd09-20261024
source_commit: 0992d9a6c6d2768d7c03c8bbdc2da22fc38bcd4e
---

# Mission task boundaries: derive holds from durable state, strip confidential fields where results are persisted

Lessons from wiring customer decisions into mission execution (CD-09): holds and gates must come from durable state, fail closed only once the guarded object is known, and a field added to a shared result schema must be audited on every path that persists that schema.

## Applicability

- mission
- mission:MSN-CUSTOMER-DECISION-CD09-20261024

## Reusable Steps

1. Lessons from wiring customer decisions into mission execution (CD-09): holds and gates must come from durable state, fail closed only once the guarded object is known, and a field added to a shared result schema must be audited on every path that persists that schema

## Expected Outcome

Applies when mission execution gains a gate, hold or confidential field that crosses task boundaries.

1. Derive a hold from durable state (the task lock / WorkItem), never only from the latest worker result: a resumed task whose rerun omits the question would otherwise complete.
2. Fail closed only after the guarded object is known (case or lock found). Errors while discovering whether it exists must fall back to the unguarded behavior with one warning per mission, or unrelated missions stop auto-completing.
3. When a confidential field joins a shared result schema (TaskResultSchema feeds the worker prompt of every dispatch path), audit every path that persists or quotes that schema: mission evidence, WorkItem attempt records, retry prompts, best-of-N candidates.
4. Strip such fields where content is persisted, field-only after parsing; never blank whole replies and never strip in a shared transport that downstream consumers read.
5. Give background work a narrow role inside an exact resource capability instead of granting a broad role to every system role that can reach the code path.
6. Keep customer-facing request paths within the surface timeout: follow-up sweeps take a short lock budget and skip with a warn; the next event retries.

## Evidence

- active/missions/public/MSN-CUSTOMER-DECISION-CD09-20261024/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-CUSTOMER-DECISION-CD09-20261024/evidence/retrospective.md
- active/missions/public/MSN-CUSTOMER-DECISION-CD09-20261024/evidence/delivery-report.md
- active/missions/public/MSN-CUSTOMER-DECISION-CD09-20261024/evidence/implementation-report.md

## Artifacts

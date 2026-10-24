---
record_id: mem-MSN-CUSTOMER-DECISION-20261024-2026_10_24
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CUSTOMER-DECISION-20261024-2026_10_24
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-24T03:15:26.202Z
source_branch: feat/customer-decision-20261024
source_commit: 2935296a50a1939ccd95a8724218f7f217b999e6
---

# Customer decisions: lock at the owning store, show provisional state, gate money decisions

Lessons from building layered customer decisions on the SSOD decision ledger: concurrency control belongs in the store that owns the file, customer screens must distinguish provisional from confirmed, and money/contract/release answers need operator confirmation.

## Applicability

- mission
- mission:MSN-CUSTOMER-DECISION-20261024

## Reusable Steps

1. Lessons from building layered customer decisions on the SSOD decision ledger: concurrency control belongs in the store that owns the file, customer screens must distinguish provisional from confirmed, and money/contract/release answers need operator confirmation

## Expected Outcome

Applies when a feature writes into a shared store (e.g. the decision ledger) or shows decisions to an external party.

1. Put the lock in the store that owns the file (withDecisionLedgerLock in libs/core/decision-ledger), not in a facade: any other writer (pnpm decisions) otherwise bypasses it. Make it re-entrant so a caller holding a case lock can nest it, and share one deadline across nested locks.
2. On customer-facing screens, state whether the current way of working is a provisional proposal or a confirmed decision; never word a receipt as final when the answer still awaits operator confirmation.
3. Answers on requires_customer topics (money, contract, release, change requests) stay provisional until the operator confirms through the approval gate.
4. Never default a sender/from field from the personal profile: that is a personal-to-public tier leak. Require an explicit value.
5. Isolate reconcile/recovery per record and journal the auditing stage so a single failure does not block the rest.

## Evidence

- active/missions/public/MSN-CUSTOMER-DECISION-20261024/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-CUSTOMER-DECISION-20261024/evidence/REVIEW-contract_authoring-ux-contract.md
- active/missions/public/MSN-CUSTOMER-DECISION-20261024/evidence/retrospective.md
- active/missions/public/MSN-CUSTOMER-DECISION-20261024/evidence/delivery-report.md

## Artifacts

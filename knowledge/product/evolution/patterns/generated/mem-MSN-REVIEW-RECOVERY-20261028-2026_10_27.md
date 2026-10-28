---
record_id: mem-MSN-REVIEW-RECOVERY-20261028-2026_10_27
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-REVIEW-RECOVERY-20261028-2026_10_27
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-27T19:21:01.937Z
source_branch: feat/hermes-adoption-20261028
source_commit: 6e9c2a827dfb68f673d27db62cec69cb7dcdb32e
---

# Keep review authorship, extraction provenance and crash-test coverage explicit

Unknown authors cannot be inferred from cascade or observers, structural extraction cannot imply LLM review, and recovery evidence must name the exact interrupted durable boundary.

## Applicability

- mission
- mission:MSN-REVIEW-RECOVERY-20261028

## Reusable Steps

1. Unknown authors cannot be inferred from cascade or observers, structural extraction cannot imply LLM review, and recovery evidence must name the exact interrupted durable boundary

## Expected Outcome

Record a task's producer in its own evidence entry. A current verified claim may supply an omitted actor, but explicit actor conflicts, stale leases, changed outputs and foreign scopes must fail before mutation. File existence and upstream task completion do not identify a dependent task's author. Repair legacy unknown authorship with target-specific evidence from the actual author, then obtain a different reviewer; registering an already performed review is deterministic and needs no reasoning-backend probe. Persist extraction mode and safe categorical fallback reason across state, Markdown, history, ledger, CLI and UI. Structural fallback or stub means no LLM extraction occurred; LLM extraction also remains distinct from independent review and approval. Missing or contradictory legacy provenance is unknown, never retroactively inferred from current settings. Test recovery by interrupting at named persisted boundaries and reading real stores in a fresh process. Synthetic plugin prepared-state recovery and OAuth claim seams do not prove every crash point or external-token exactly-once execution. Keep visual QA, real-service validation and whole-repository test claims separate from scoped regression evidence.

## Evidence

- active/missions/public/MSN-REVIEW-RECOVERY-20261028/evidence/implementation-report.md
- active/missions/public/MSN-REVIEW-RECOVERY-20261028/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-REVIEW-RECOVERY-20261028/evidence/test-report.md
- active/missions/public/MSN-REVIEW-RECOVERY-20261028/evidence/replay-probe.json

## Artifacts

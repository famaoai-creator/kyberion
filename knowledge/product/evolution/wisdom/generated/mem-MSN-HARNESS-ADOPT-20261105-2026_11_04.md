---
record_id: mem-MSN-HARNESS-ADOPT-20261105-2026_11_04
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-HARNESS-ADOPT-20261105-2026_11_04
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-04T23:29:13.246Z
source_branch: feat/delegation-result-idempotency-20261105
source_commit: 28a4ee72033cc671dba95b25ee1eee6c06a8ad46
---

# Honest verdicts and at-most-once execution: a review checklist

Verification, de-duplication, isolation and draft-to-confirm code tends to be correct on the happy path and wrong at the boundary. Run these five checks, each with one adversarial test, before calling such code done.

## Hint Scope

mission

## Trigger Phrases

- ## Checklist

1. **A verdict must not be satisfiable by construction.** Judge from evidence the subject itself produces (its own result or stored output), never from state your own wrapper sets. Test with a subject that ignores the request and assert it is not a pass.
2. **Echoes and transport errors are not evidence.** A check that only looks for a word in the reply passes a subject that repeats the request. Timeouts and transport errors are `unreported`, not `fail`; only a judged wrong answer is `fail`; keep the latest judgement per subject, not the union of all runs.
3. **Unknown start state counts as started.** Persist the start mark before executing; release an idempotency reservation only on structural proof that nothing started (an explicit marker, a spawn that never happened), never on error-message wording; settle a dead owner as interrupted instead of re-running. Liveness needs host + process start identity, a heartbeat lease and a bounded wait.
4. **Enumerate every launch site before claiming isolation.** Search every process spawn and every environment spread before stating a fail-closed guarantee, and list each site and its behaviour in the boundary document.
5. **A draft must not be able to target existing state.** Reserve identifiers across every store the confirm step writes, and make the confirm step refuse an explicit existing identifier unless an update flag is given.

## How to apply

When writing or reviewing such code, add one adversarial test per check: a subject that ignores the request, a subject that echoes, a crash after start, an unlisted launch site, a colliding identifier. See also knowledge/product/governance/contract-design-principles.md.

## Recommended References

- active/missions/public/MSN-HARNESS-ADOPT-20261105/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-HARNESS-ADOPT-20261105/evidence/implementation-report.md
- active/missions/public/MSN-HARNESS-ADOPT-20261105/evidence/test-report.md

## Evidence

- active/missions/public/MSN-HARNESS-ADOPT-20261105/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-HARNESS-ADOPT-20261105/evidence/implementation-report.md
- active/missions/public/MSN-HARNESS-ADOPT-20261105/evidence/test-report.md

## Artifacts

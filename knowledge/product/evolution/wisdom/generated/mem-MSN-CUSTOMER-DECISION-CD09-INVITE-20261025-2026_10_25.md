---
record_id: mem-MSN-CUSTOMER-DECISION-CD09-INVITE-20261025-2026_10_25
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CUSTOMER-DECISION-CD09-INVITE-20261025-2026_10_25
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-25T17:01:41.356Z
source_branch: feat/customer-decision-cd09-invite-20261025
source_commit: 4315253c665d44c5ab08a9bad968b8191bcda3b3
---

# Handing confidential values to a worker prompt: gate on the mission scope, scrub stored copies, decide on what was seen, one hold rule

When a resumed task needs confidential customer answers, deliver them only in the in-memory prompt of a mission whose context-pack scope may carry that tenant's confidential data; keep every persisted form ids-only; run acceptance logic on the raw result but scrub every stored/sent copy; and drive every hold boundary from one shared state function.

## Hint Scope

mission

## Trigger Phrases

- ## Context

CD-09 delivered confirmed customer decisions to tasks resumed after a customer hold; CD-10 required an active registry tenant for invite storage.

## Lessons

1. Gate confidential prompt content on the mission's own context-pack security scope (same tenant, write_tier confidential, egress deny, pack not degraded) and block the task otherwise — reference-only delivery makes the worker guess.
2. Hold values in a holder whose toJSON / inspect / toString expose ids only, so accidental serialization into events, logs or WorkItems is harmless.
3. Separate 'decide on what was seen' from 'store what is safe': scrubbing the in-memory result broke the acceptance gate (artifact paths, criteria matching, enum fields). Gate and reviewer on the raw result; scrub every stored, sent and notified copy, including reviewer gaps, gate reasons and best-of-N losers. Scrub must be idempotent (keep existing markers) and whole-word for short values, Unicode-aware.
4. When a hold depends on several stores (consumer-lock stamp, agenda state, ledger), one shared state function must drive every boundary (pin, sweep, record-evidence, reconcile, overview). Divergent rules produced a never-releasable hold, a release/hold loop and silently dropped answers.
5. A ledger fallback must check the record still stands (active and not named in a later supersedes); otherwise a superseded value is delivered as confirmed.
6. Distinguish 'no case' from 'read failed'; block only tasks known to carry decisions, retry once otherwise.
7. Content not gated by tier (ids-only notes) must not carry short hashes of tenant names into lower-tier missions — use counts there.
8. Canonical-JSON comparisons used by write guards must be prototype-safe (Object.create(null) + defineProperty); a **proto** key otherwise vanishes from the comparison.
9. For public-facing surfaces, check input format before tenant state so error kinds never reveal registration state.

## How to apply

Before adding confidential data to any worker prompt, list every place the prompt or result is persisted or excerpted (bridge excerpts, observability, WorkItems, events, NEXT_TASKS, prompt-visibility, compaction, best-of-N) and add a sentinel leak-sweep test over active/shared/** and the public mission directory.

## Recommended References

- active/missions/public/MSN-CUSTOMER-DECISION-CD09-INVITE-20261025/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-CUSTOMER-DECISION-CD09-INVITE-20261025/evidence/implementation-report.md
- active/missions/public/MSN-CUSTOMER-DECISION-CD09-INVITE-20261025/evidence/retrospective.md
- active/missions/public/MSN-CUSTOMER-DECISION-CD09-INVITE-20261025/evidence/design-spec.json
- active/missions/public/MSN-CUSTOMER-DECISION-CD09-INVITE-20261025/evidence/test-report.md

## Evidence

- active/missions/public/MSN-CUSTOMER-DECISION-CD09-INVITE-20261025/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-CUSTOMER-DECISION-CD09-INVITE-20261025/evidence/implementation-report.md
- active/missions/public/MSN-CUSTOMER-DECISION-CD09-INVITE-20261025/evidence/retrospective.md
- active/missions/public/MSN-CUSTOMER-DECISION-CD09-INVITE-20261025/evidence/design-spec.json
- active/missions/public/MSN-CUSTOMER-DECISION-CD09-INVITE-20261025/evidence/test-report.md

## Artifacts

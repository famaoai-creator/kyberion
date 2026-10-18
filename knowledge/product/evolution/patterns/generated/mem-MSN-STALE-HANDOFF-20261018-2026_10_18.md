---
record_id: mem-MSN-STALE-HANDOFF-20261018-2026_10_18
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-STALE-HANDOFF-20261018-2026_10_18
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-18T06:43:28.466Z
source_branch: fix/stale-handoff-20261018
source_commit: eb7e8d154153b405f95bee364ffc7ba44a250c0e
---

# Bind hearing handoffs to the displayed decision

A reservation CAS only fences changes during preparation. A handoff must also carry a semantic snapshot of the decision the operator actually viewed, and revalidate current actor binding before reservation.

## Applicability

- mission
- mission:MSN-STALE-HANDOFF-20261018

## Reusable Steps

1. A reservation CAS only fences changes during preparation
2. A handoff must also carry a semantic snapshot of the decision the operator actually viewed, and revalidate current actor binding before reservation

## Expected Outcome

# Bind hearing handoffs to the displayed decision

Apply this rule when a UI turns a mutable, decided hearing into a mission or work-inventory entry.

1. Return a versioned freshness snapshot atomically inside the sanitized displayed record. Bind semantic requirements and the accepted decision to the actual authenticated server scope, principal, source, registered member, session, scenario and destination kind. A freshness validator is not an authorization capability: retain current request and destination authorization.
2. Capture an immutable copy of that displayed snapshot before dispatch or storage callbacks. Never fetch a newer proof at click time, substitute current server content for missing proof, or silently re-decide a stale view.
3. Validate before preparation and verified replay. Give every newly accepted decision a monotonic revision, including legacy calls; old records may use revision zero without a read-time migration. Preserve the identity across exact replay and presentation-only canvas updates.
4. Keep the semantic CAS at the reservation boundary. Include the decision revision and operation identifier so same-actor, same-timestamp redecisions cannot pass. After asynchronous preparation, resolve the initiating member again and reject removed or remapped identities before reserving or saving.
5. Preserve uncertain-outcome ownership independently. A stale response must not authorize an automatic resend, and a completion GET does not prove the exact uncertain attempt. Keep drafts and no-resend markers intact while offering existing-state checks and ordinary conversation.

Validation should include view A, separately saved decision B, then click A through the real route and client harness. Also exercise current valid handoffs, exact repeats, legacy and versioned same-time decisions, canvas-only advances, cross-tenant/current-actor changes, member removal during preparation, malformed proof, repeated clicks and late responses. Report rendered browser validation separately from handler/client integration.

## Evidence

- active/missions/public/MSN-STALE-HANDOFF-20261018/evidence/reproduction-and-scope.md
- active/missions/public/MSN-STALE-HANDOFF-20261018/evidence/implementation-report.md
- active/missions/public/MSN-STALE-HANDOFF-20261018/evidence/test-report.md
- active/missions/public/MSN-STALE-HANDOFF-20261018/evidence/REVIEW-execution-implement.md

## Artifacts

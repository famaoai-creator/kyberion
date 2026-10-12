---
record_id: mem-MSN-DOT-EVENT-CONTINUATION-20261012-2026_10_12
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-DOT-EVENT-CONTINUATION-20261012-2026_10_12
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-12T04:46:02.050Z
source_branch: feat/dot-event-continuation-20261012
source_commit: bc67d5f4f94865a321c936741a2acb170b096c67
---

# Durable event continuation must preserve uncertainty at the effect boundary

Bound source reading and pending state separately; adopt only future events explicitly, persist claims before providers, and hold ambiguous attempts rather than replaying them.

## Applicability

- mission
- mission:MSN-DOT-EVENT-CONTINUATION-20261012

## Reusable Steps

1. Bound source reading and pending state separately; adopt only future events explicitly, persist claims before providers, and hold ambiguous attempts rather than replaying them

## Expected Outcome

A bounded tail is a diagnostic view, not a durable queue: prove regressions with genuinely accepted distinct events, because payload deduplication can suppress a second test delivery. For forward adoption, capture the complete-line EOF under the same append lock, retain immutable source identity/anchors, and write pending references plus cursor atomically before offering work. A bounded pending capacity must stop reading rather than evict older work.

An offer is not acknowledgement. Persist an exclusive full-scope attempt claim immediately before any provider call, since the provider itself may perform effects. After that boundary, failures, timeouts, crashes, partial tool errors and incomplete goal results remain ambiguous and must not become automatic retries or successful receipts. Repository-controlled retries and failover, including empty streaming output and adapter-level fallback, must respect a lexical per-attempt guard; ordinary unrelated calls retain their existing behavior. Opaque external CLI internals and downstream effects still require their own idempotency guarantees.

Missing state, source rotation/truncation, mismatched scope or trigger contract and torn adoption boundaries hold instead of silently resampling EOF. Show recorded pending, held attempts and unread bytes truthfully, while separately disclosing historical uncertainty and any unbounded legacy receipt reader. Recovery and historical replay require separately governed decisions; no reset/lease-expiry shortcut can prove an uncertain effect did not happen.

Verify with more accepted rows than the old scan limit, a fresh process restart, simultaneous claimers, partial effect followed by failure, and legacy behavior outside the guarded mode. This mission proved 2,001 distinct accepted events continue across process restart with bounded pending state and no duplicate synthetic effects.

## Evidence

- active/missions/public/MSN-DOT-EVENT-CONTINUATION-20261012/evidence/test-report.md
- active/missions/public/MSN-DOT-EVENT-CONTINUATION-20261012/evidence/REVIEW-execution-implement.md

## Artifacts

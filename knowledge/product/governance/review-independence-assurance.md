---
title: Review independence assurance and migration
tags: [governance, review, identity, provenance]
last_updated: 2026-11-04
---

# Review independence assurance and migration

## Current contract

Artifact review receipt v1 remains readable and retains its existing admission
behavior. Its `independence_verified` field is historical naming for a comparison
of claimed actor IDs. It is **not** proof of an authenticated actor or independent
execution. Neither a canonical-looking NHI ID nor different provider, model,
session, role, or display names establishes independence.

`evaluateArtifactReviews` now reports `independence_assurance` separately from
`ready`. The values are `not_required`, `legacy_actor_claim`, and `unverified`.
There is deliberately no authenticated success value or caller-supplied proof
flag. `ready: true` under the default policy continues to mean that existing
artifact, verdict, role, and legacy separation checks passed. It does not upgrade
an old receipt's assurance.

The optional `independencePolicy: 'authenticated_execution'` demands stronger
evidence and currently **always blocks** with an explicit missing-provenance
reason, including when `requireIndependence` is false or evidence is empty.
Unknown policy values fail closed. This is an opt-in migration boundary, not an
implemented authenticated review service. Do not enable it for an operational
workflow expecting completion until the capture and verification path below is
available. Omission or `legacy_actor_claim` preserves the current policy.

Prepared VCS development uses the same evaluator and accepts the same optional
policy through `PreparedDevelopmentInput`. Its review verification result reports
the assurance. Strict failures prevent publication even when the separate mission
gate is disabled. Other mission callers retain their legacy policy; no new CLI,
environment variable, tenant policy setting, or persisted receipt field is added.

## Why existing records cannot be promoted into proof

- `currentActor()` is an attribution projection, not authentication proof.
- The mission execution ledger accepts caller actor/runtime attribution and can
  resolve mutable staffing. Its integrity chain does not authenticate the actor.
- WorkItem attempts are durable coordination records, but their actor identity
  originates in dispatch claims. Runtime receipts may use an agent ID as a
  runtime ID or accept a runtime ID returned by an A2A response.
- NHI admission proves permission to act under an identity, not who actually
  produced or reviewed particular bytes. Current bindings may disappear on
  release, expiry, suspension, retirement, or reassignment.

Joining these strings or reading today's identity registry cannot reconstruct
authenticated historical production/review. A legacy receipt must not become
verified merely because an actor is admitted later.

## Required end-to-end follow-up

1. At actual execution admission, resolve the authenticated canonical actor
   from an authenticated adapter or admitted session. Separately have the host
   establish a runtime-incarnation ID and execution/attempt ID. A session or
   model-selected string is not a host runtime identity. Preserve canonical NHI
   identity separately from its accountable human: distinct NHIs sharing one
   accountable human are not automatically the same actor.
2. Capture immutable producer attestations and reviewer attestations at trusted
   execution boundaries. Bind tenant (or an explicit public scope), mission,
   target task, review task, artifact path and digest, all producers, canonical
   actor, host runtime incarnation, attempt, outcome, and exact review digest.
   The review must reference the exact production evidence it examined.
3. Use a governed, durable append path whose authority is separate from untrusted
   task output. Persist successfully before publishing strong completion. Do not
   make proof capture best-effort. Preserve immutable event identifiers and
   relevant admission evidence after release; never persist session secrets.
4. At every consuming gate, load and verify the referenced historical records,
   scope, integrity, digest, ordering, and complete producer set. Reject missing,
   ambiguous, forged, replayed, cross-tenant/task/artifact, or mismatched records.
   Same canonical NHI under different aliases/sessions fails. Same or ambiguous
   host runtime fails even with different NHI labels. A new session does not
   erase implementation history. Do not collapse NHIs by accountable human.
5. Integrate all producers and review writers: direct `record-evidence` and
   `review-task`, mission orchestration, WorkItem dispatch, CLI subagents, A2A,
   and commit-bound reconciliation. Readers include lifecycle completion,
   mission governance, reconciliation, maintenance, and prepared VCS promotion.
   Pre-dispatch label exclusions are useful selection filters, not proof.
6. Introduce a versioned strong receipt and audit unsupported routes before
   changing defaults. Legacy records remain readable and explicitly legacy;
   require fresh attested review instead of backfilling invented provenance.
   A workflow requiring authenticated assurance must never silently fall back.

## Regression gates

Run `libs/core/workforce/artifact-review.test.ts` and
`libs/core/vcs/development-review-integration.test.ts`. Cover legacy admission,
strict failure independent of the old boolean switch, empty and forged evidence,
unknown policy, canonical-looking IDs, aliases, same or absent runtime claims,
and prevention of publication under strict policy. Future positive attestation
tests must exercise actual trusted capture and persisted verification, including
historical evaluation after release and distinct NHIs with one accountable human.

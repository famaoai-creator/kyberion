---
title: Kyberion Ecosystem Evolution Roadmap
category: Architecture
status: proposed
owner: ecosystem_architect
last_updated: 2026-06-24
tags: [roadmap, sovereignty, approval, mesh-hub, memory, model-routing, browser-extension]
---

# Kyberion Ecosystem Evolution Roadmap

## 1. Purpose

This roadmap turns the June 2026 concept review into an implementable sequence.
It is a subordinate plan of [`docs/PRODUCTIZATION_ROADMAP.md`](../../../docs/PRODUCTIZATION_ROADMAP.md), not a replacement for it. The productization roadmap remains the authority for OSS and FDE priorities; this document owns the dependency order, contracts, and exit criteria for ecosystem evolution.

The north-star is a sovereign operating space where a person can ask for work, inspect and approve the plan, receive an accountable result, and reuse evidence-backed learning. Multiple agents, models, and devices are supporting mechanisms, never alternate authorities.

## 2. Review of the Proposed Concept

### 2.1 Accepted foundations

The proposed three pillars are directionally correct:

1. **Governed work produces accountable results.** Kyberion is more than a task runner: it converts intent into governed execution, evidence, and reusable knowledge.
2. **Sovereignty is an architectural property.** Tier isolation, `secure-io`, validated ADF, approval policy, and recipient-side checks are the right foundations for operating on a user's real environment.
3. **Learning must be a closed loop.** Evidence from execution should improve later resolution and approvals, rather than becoming an unsearchable log archive.

### 2.2 Required corrections

| Proposal                                                                              | Review                                                                                                                                                                     | Correct implementation rule                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every action converges to `Project -> Track -> Outcome -> Artifact`.                  | Too absolute. Direct answers and bounded task sessions must not create a project merely to preserve a hierarchy. `Outcome` is a success condition, not always an artifact. | Use `Project` only for durable business context. A `Mission` or `Task Session` links to a project/track when one exists. Every governed execution records outcome criteria, artifacts, and evidence separately.        |
| The data tiers and ADF validation structurally eliminate risk.                        | Correct direction, but neither is sufficient alone. Inputs from a browser page, extension, peer, or model remain untrusted after schema validation.                        | Enforce capability, authority, origin, tenant, approval, and recipient-side policy at the action boundary. A delivered request never grants execution authority.                                                       |
| Traces can autonomously rewrite `HINTS.md` or durable rules.                          | Unsafe as stated. Raw logs are not reusable knowledge, and automatic structural edits can encode one-off failures or attacker-controlled content.                          | Trace processing can automatically create a redacted, deduplicated `Memory Candidate`; promotion to governed guidance follows evidence, scope/tier validation, and human ratification where a structural rule changes. |
| Mesh Hub has moved Kyberion from an individual agent to a distributed mesh.           | Premature. Mesh Hub v1 establishes a local, same-tenant, single-writer control plane with deterministic eligibility and operator selection.                                | Treat v1 as the foundation for a pilot. Network federation, public-key identity, automatic scheduling, and cross-tenant sharing remain future work.                                                                    |
| Resource-aware routing and hierarchical model allocation are the next immediate step. | Their order is reversed. Optimizing an unproven trust boundary would make failures harder to explain and audit.                                                            | First prove operator-visible approval, evidence, and same-tenant peer delivery. Then add signed identity. Add routing only in advisory mode before constrained automation.                                             |

### 2.3 Current implementation baseline

| Area                        | Current capability                                                                                                                                                                                                         | Boundary that remains                                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work lifecycle              | Project, mission, task-session, artifact, evidence, and memory-candidate concepts already exist.                                                                                                                           | The canonical relationship must remain visible in one operator state model.                                                                                                                                                 |
| Approval and browser bridge | `approval-*` core modules and `tools/adf-replay-extension/` provide a Side Panel prototype, recording contracts, review state, and a preflight that blocks extension execution without a Native Messaging bridge.          | There is no production Native Messaging host, issued lease store, or end-to-end approval-to-execution path.                                                                                                                 |
| Learning                    | `memory-promotion-queue`, promotion workflow, distill candidate registry, and the corporate memory loop are implemented.                                                                                                   | `pipelines/fragments/memory-distillation.json` now nominates a promotion candidate; approved knowledge hints append into `knowledge/product/governance/HINTS.md` through the promotion workflow.                            |
| Mesh Hub                    | Registration, presence, capability advertisements, durable delivery, topic rules, inspection, and a `peer-messaging` adapter are present. Same-tenant eligibility is deterministic and automatic peer selection is denied. | It is not a network service or a distributed scheduler. Peer transport currently uses an HMAC shared secret, which verifies integrity but does not provide independently verifiable peer identity, rotation, or revocation. |
| Model routing               | The model registry and `reasoning-model-routing` produce shadow recommendations for intent compilation.                                                                                                                    | It does not yet make live dispatch decisions, enforce budget policy, or record counterfactual quality evidence.                                                                                                             |

## 3. Canonical Product Model

The user-facing vocabulary stays small:

```text
Request -> Plan -> State -> Result
```

The governed path beneath it is:

```text
Intent
  -> resolution (direct answer | task session | mission | project bootstrap)
  -> outcome and authority contract
  -> approved execution
  -> artifact + evidence
  -> memory candidate
  -> assessed promotion
  -> later reuse
```

The following invariants apply in every roadmap milestone:

1. A plan, approval, execution lease, artifact, evidence record, and promoted memory must be traceable by stable identifiers.
2. A peer, browser extension, model, and browser page are untrusted inputs. None may mutate mission state or invoke an actuator directly.
3. `personal` data is never routed through Mesh Hub. `confidential` payloads remain references under same-tenant policy. Hub logs store metadata, hashes, and governed references rather than payloads.
4. The extension receives only a short-lived lease with an origin, tab, operation, and approved-step-hash scope. Navigation, tab changes, expiry, or ambiguity revoke execution.
5. Automatic learning creates candidates, not durable policy changes. A candidate cannot lower an approval threshold or broaden a capability grant.
6. Automatic routing is opt-in, explainable, bounded by budget and data tier, and initially limited to idempotent, low-risk request kinds.

## 4. Sequenced Roadmap

### Milestone E0: Make the control loop observable

**Goal:** Make a person see one coherent state across terminal, dashboard, approval store, browser bridge, and Mesh Hub.

**Implementation slices**

1. Define `operator-work-state.v1` with request, resolution, outcome, authority, approval, execution, evidence, and next-action summaries.
2. Add an adapter for the existing mission, task-session, approval, browser-extension, and Mesh inspection records. Do not migrate ownership into a new global store.
3. Render the same state vocabulary in the Sovereign Dashboard and the browser extension Side Panel: `Draft`, `Needs review`, `Waiting for approval`, `Executing`, `Blocked`, `Verified`, `Learning candidate`, and `Completed`.
4. Add an ADR that fixes the canonical vocabulary and maps legacy status strings to it.

**Primary paths**

- New: `knowledge/product/schemas/operator-work-state.schema.json`
- New: `libs/core/operator-work-state.ts`
- Update: `scripts/sovereign_dashboard.ts`, `tools/adf-replay-extension/sidepanel.*`
- Tests: `libs/core/operator-work-state.test.ts`, dashboard contract tests, extension state rendering tests

**Exit criteria**

- One fixture from each of mission, browser approval, and mesh delivery produces the same user-visible state and a runnable next action.
- No screen claims that approval means execution, or that delivery means mission acceptance.

### Milestone E1: Close the browser co-working trust loop

**Goal:** Turn the existing recording and review prototype into an understandable, interruptible approval workflow before enabling arbitrary browser execution.

**Implementation slices**

1. Persist `browser-recording.v1` review decisions in the governed approval store rather than extension-local state alone. Each decision records reviewer, policy version, selected actions, reason, and expiry.
2. Implement the Native Messaging host `com.kyberion.browser_bridge` as a local-only, extension-ID allowlisted adapter. It accepts typed requests only and delegates validation to Kyberion core; it never accepts arbitrary ADF or page-originated commands.
3. Issue `execution_lease.v1` after preflight and approval. Bind it to mission, pipeline, extension session, tab, origin, operation set, step hashes, policy version, issued time, and expiration.
4. Implement the extension's explicit post-decision states: an approval shows what was approved, which step is next, and the lease deadline; a rejection shows what will not run and whether the user can revise the draft; cancellation and disconnect produce an aborted receipt.
5. Introduce `browser:extension_session` as a request to the local bridge, not a browser executor. Preserve `browser:pipeline` for Playwright/CDP execution.

**Primary paths**

- New: `libs/core/browser-extension-session-store.ts`, `libs/core/browser-extension-native-host.ts`
- Update: `libs/core/browser-extension-bridge.ts`, `libs/core/approval-store.ts`, `knowledge/product/governance/approval-policy.json`
- Update: `tools/adf-replay-extension/background.js`, `content.js`, `sidepanel.js`, `manifest.json`
- New contracts: execution-lease schema and native-host request/receipt schema

**Exit criteria**

- An observe/record/review/approve/execute/verify flow works on one ordinary site and one SPA without capturing form values, cookies, OTPs, or tokens.
- High-risk actions require a fresh step approval and fail closed after tab switch, navigation, lease expiry, or target ambiguity.
- Extension storage holds redacted drafts only and removes them on completion, cancellation, or retention expiry.

### Milestone E2: Make learning governed and measurable

**Goal:** Convert execution evidence into useful candidates without allowing a model or a trace to modify durable policy by itself.

**Implementation slices**

1. Replace direct `HINTS.md` writes in `pipelines/fragments/memory-distillation.json` with a typed candidate producer that uses the existing promotion queue.
2. Add a trace assessment gate: provenance, redaction, tenant/tier scope, recurrence, evidence quality, confidence, and rollback target are required before queueing.
3. Deduplicate candidates by normalized problem, environment, affected capability, and evidence hash. Mark contradictory candidates for reviewer attention instead of merging them.
4. Generate a read-only operator digest from approved/promoted memory. `HINTS.md` becomes a deterministic rendered view, if retained, rather than an autonomous source of truth.
5. Measure resolution impact: candidate reuse, approval reversals, recurrence of the original failure, and false-promotion rate.

**Primary paths**

- Update: `pipelines/fragments/memory-distillation.json`, `libs/core/memory-promotion-workflow.ts`, `libs/core/distill-candidate-registry.ts`
- New: `libs/core/trace-memory-assessment.ts`, `libs/core/promoted-memory-renderer.ts`
- Update: `knowledge/product/governance/mission-distill-markdown-policy.json`, corporate memory documentation

**Exit criteria**

- A malicious or irrelevant trace cannot create a durable hint without a candidate record, scoped evidence, and the required ratification.
- A replayed incident produces one deduplicated candidate and an operator can explain why it was promoted, rejected, or expired.
- The candidate workflow has regression tests for redaction, tier downgrade, prompt-injection text in traces, conflicting advice, and rollback.

### Milestone E3: Prove Mesh Hub in a same-tenant operator pilot

**Goal:** Validate the already merged Mesh Hub against real collaboration workflows before federation or resource scheduling.

**Implementation slices**

1. Create a two-peer, same-tenant reference environment with explicit enrollment, heartbeat, capability advertisement, review request, work-item handoff, acknowledgement, rejection, retry, and dead-letter scenarios.
2. Connect the Mesh inspection output to `operator-work-state.v1`, including recipient acceptance and a clear distinction between delivered, accepted, and executed.
3. Add failure injection for stale presence, duplicate delivery, revoked peer, tenant mismatch, malformed payload reference, and recipient policy rejection.
4. Publish the allowed remote request vocabulary and keep shell, actuator, secret, browser action, and mission lifecycle requests local-only.

**Primary paths**

- Update: `tests/mesh-peer-network.bootstrap.json`, `scripts/mesh_hub_inspect.ts`, `knowledge/product/orchestration/mesh-hub-inspection.md`
- Update: `libs/core/mesh-hub-inspection.ts`, `libs/core/mesh-hub-peer-messaging-adapter.ts`
- New: two-peer integration and operator-journey tests

**Exit criteria**

- An operator can reconstruct every pilot request without viewing protected payloads.
- A delivered `review.request` or `workitem.handoff` cannot create or mutate a recipient mission until that recipient independently accepts it.
- The pilot proves restart recovery and dead-letter handling with a single writer per runtime root.

### Milestone E4: Establish verifiable peer identity before scheduling

**Goal:** Replace the current shared-secret transport trust with independently verifiable, revocable peer identity while retaining same-tenant scope.

**Implementation slices**

1. Record an ADR selecting an application-level Ed25519 signing identity and tenant trust-root model. Do not reuse SSH-agent or PGP identities by default: their key selection, lifecycle, and operator expectations do not match a Kyberion service identity.
2. Add enrollment proof-of-possession, key identifiers, key rotation, peer revocation, and signed-envelope verification. Keep payload encryption and transport confidentiality separate from signature verification.
3. Store private signing material through the established secret boundary or OS secure storage; retain public keys, attestations, and revocation metadata as governed records.
4. Require a migration period in which HMAC and public-key envelopes coexist under explicit version negotiation, then remove the shared-secret-only path.

**Primary paths**

- New: `libs/core/mesh-peer-identity.ts`, `libs/core/mesh-envelope-signature.ts`
- Update: `libs/core/peer-messaging.ts`, `libs/core/mesh-hub-peer-messaging-adapter.ts`, Mesh schemas and policy
- New governance: peer identity, key rotation, revocation, and cryptographic-agility ADRs

**Exit criteria**

- A peer cannot impersonate another peer merely by learning a tenant-wide shared secret.
- Rotation and revocation take effect before routing and are visible in Mesh inspection.
- Cross-tenant routing remains denied; no cross-tenant feature is inferred from having signatures.

### Milestone E5: Add advisory resource and model routing

**Goal:** Use the mesh and model information to recommend cost- and capability-aware choices without hiding authority or safety decisions.

**Implementation slices**

1. Expand presence with optional, privacy-minimized capability claims: approved model IDs, cost/latency bands, free worker slots, queue class, and accelerator class. Do not publish raw machine inventory, prompts, token contents, or secret-bearing environment values.
2. Extend `reasoning-model-routing` from a shadow recommendation to an explainable `RoutingAdvice` record. Its inputs include task class, data tier, authority, budget, latency target, required capabilities, and allowed providers.
3. Present ranked candidates and a reason in the operator surface. The default remains operator selection for multi-peer candidates.
4. Allow automated selection only behind policy flags, only for idempotent low-risk work such as analysis or review requests, and only when the budget, model status, data tier, and recipient acceptance all pass.
5. Capture outcomes for counterfactual evaluation: recommendation, selected peer/model, cost estimate and actual, latency, verification result, approval reversal, and operator override.

**Primary paths**

- Update: `knowledge/product/governance/model-registry.json`, `libs/core/reasoning-model-routing.ts`, Mesh presence/capability contracts
- New: `libs/core/routing-advice.ts`, `knowledge/product/governance/routing-policy.json`
- Tests: deterministic advice, policy denial, budget exhaustion, stale telemetry, counterfactual recording, and no-secret telemetry tests

**Exit criteria**

- Every recommendation is reproducible from its recorded policy and input metadata.
- Resource or model data can never override tenant, tier, approval, or recipient acceptance policy.
- Automated routing has a kill switch and remains disabled for side effects, mission lifecycle actions, personal data, and ambiguous tasks.

## 5. Delivery Order and PR Boundaries

| PR  | Depends on    | Scope                                                        | Required validation                                                                 |
| --- | ------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 1   | None          | E0 operator-state schema, adapters, dashboard contracts, ADR | schema checks, focused core tests, dashboard contract tests                         |
| 2   | PR 1          | Browser review persistence and approval-state UX             | approval/core tests, extension unit tests, manual Side Panel review journey         |
| 3   | PR 2          | Native Messaging host and lease contracts                    | host contract tests, expired/mismatched lease tests, local Chrome smoke             |
| 4   | None          | E2 candidate-only trace distillation                         | memory workflow tests, redaction/tier/prompt-injection regression tests             |
| 5   | PR 1          | E3 two-peer Mesh pilot and operator inspection               | mesh focused suite, restart/retry/dead-letter integration scenario                  |
| 6   | PR 5          | E4 peer identity and rotation                                | signature, enrollment, rotation, revocation, compatibility tests                    |
| 7   | PR 5 and PR 6 | E5 advisory resource/model routing                           | deterministic routing tests, policy/kill-switch tests, counterfactual evidence test |

PRs 2 and 4 may proceed in parallel after PR 1's state vocabulary is accepted. PR 5 may proceed in parallel with PR 2, but PR 6 and PR 7 must not start from an assumption that Mesh Hub v1 is a federated scheduler.

## 6. Review and Release Gates

Every implementation PR receives these reviews before merge:

| Gate                 | Required question                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture         | Does the change preserve the ownership model: mission owner, recipient acceptance, and actuator boundary?                                          |
| Security and privacy | Are data tier, tenant, origin, capability, approval, secret, and payload-redaction boundaries enforced and tested?                                 |
| Operator UX          | Can a person tell what will happen, why it is blocked, who must act, and what happens after approval or rejection?                                 |
| Reliability          | Are retry, restart, cancellation, expiry, ambiguity, and idempotency represented as explicit states with receipts?                                 |
| Learning quality     | Does promotion remain evidence-backed, reversible, and scoped? Does a failure actually become a useful candidate rather than raw log accumulation? |
| Productization       | Does the change improve a master-roadmap objective, especially first win, failure explanation, 30-day operation, or contributor clarity?           |

## 7. Decisions Required Before Implementation

The following are architecture decisions, not implementation details for a worker to infer:

1. Which existing control surface becomes the first owner of `operator-work-state.v1`: the terminal dashboard, a browser application, or both through a shared renderer?
2. Which local operating systems are supported by the first Native Messaging host, and how will its binary be signed, upgraded, and removed?
3. Which approval roles can issue high-risk browser leases, what is the maximum lease duration, and which events require re-approval?
4. Which evidence classes may produce automatically queued memory candidates, and which always require an explicit operator request?
5. Which trust root administers same-tenant peer identities, and what is the emergency revocation path when the primary host is offline?
6. What budget unit and provider-accounting source will make model-routing advice auditable without exposing tenant billing details?

Each answer must be captured as an ADR under `knowledge/product/architecture/decisions/` before the dependent PR starts.

## 8. Success Measures

This roadmap is successful when Kyberion can demonstrate all of the following in a reproducible local environment:

1. A user records a browser task, reviews a human-readable plan, approves only the intended steps, observes execution, and receives a redacted receipt with a clear next action.
2. An execution failure creates a governed memory candidate, not an unreviewed durable rule, and a later matching request demonstrably uses the promoted learning.
3. Two same-tenant Kyberion peers exchange a review or handoff request with independently visible delivery and acceptance state, without payload leakage or direct mission mutation.
4. The system can explain why a specific peer or model was recommended and prove that policy and approval constraints outranked cost or resource signals.

---
title: Kyberion Mesh Hub Implementation Instructions for GPT-5.4 mini
category: Architecture
tags: [architecture, peer, messaging, discovery, routing, coordination, gpt-5.4-mini]
importance: 9
author: Ecosystem Architect
last_updated: 2026-06-24
---

# Kyberion Mesh Hub Implementation Instructions for GPT-5.4 mini

## 1. Purpose

Implement a governed message hub that lets Kyberion instances discover one another, advertise their current ability to receive work, route typed requests to suitable peers, and publish narrowly scoped notifications.

The Mesh Hub is a control-plane service. It must not become an execution engine, a mission-state owner, or a bypass around recipient-side approval and policy checks.

This instruction set is deliberately split into small, deterministic patches for `gpt-5.4-mini`. `gpt-5.5-medium` coordinates task assignment, resolves cross-cutting design questions, and owns all integration decisions.

## 2. Goals and Exit Criteria

### Goals

1. An operator can determine which registered Kyberion peers are reachable, what tenant they belong to, and what capabilities they currently advertise.
2. A sender can target a request by exact peer ID, role, or capability without directly selecting an endpoint.
3. The hub can durably accept, deduplicate, acknowledge, retry, expire, and dead-letter messages before a recipient processes them.
4. Topic delivery supports explicit, policy-governed subscriptions; it does not implement unrestricted network broadcast.
5. Delivery of a request never implies permission to execute it. Recipient-side policy, approval, A2A, WorkItem, and mission boundaries remain authoritative.
6. Operators can inspect routing decisions, delivery state, and rejection reasons without viewing protected payloads by default.

### Definition of Done

- All v1 schemas validate through the repository schema checks.
- Discovery, heartbeat expiry, routing, delivery retry, deduplication, dead-lettering, and topic authorization have focused tests.
- A same-host two-peer end-to-end scenario passes without a live LLM or external network dependency.
- A recipient can convert an accepted request into a proposed WorkItem or A2A task contract, but no inbound message can start a mission or mutate mission state directly.
- `pnpm build`, focused tests, `pnpm run check:contract-schemas`, and `pnpm run validate` pass at the release gate.
- A security review records no unresolved high-severity finding.

## 3. Non-Goals and Invariants

### Non-Goals for v1

- Cross-tenant federation, public Internet discovery, or peer-to-peer gossip.
- Unbounded broadcast, arbitrary wildcard subscriptions, or payload replication to every peer.
- Replacing existing `peer-messaging`, A2A, WorkItem, or mission-control mechanisms.
- Executing an arbitrary natural-language message, pipeline, actuator call, or mission transition on receipt.
- Distributed consensus or exactly-once processing guarantees.

### Architecture Invariants

- `peer-messaging` remains the signed peer transport adapter; the hub owns routing and durable delivery semantics above it.
- A2A remains bounded agent-work delegation.
- Work coordination remains the durable owner of leases, handoffs, and WorkItem status.
- `mission_controller` remains the only owner of mission-wide lifecycle transitions.
- Incoming peer payloads are untrusted data. A recipient must independently validate schema, tenant, authority, approval, and capability policy.
- Runtime data uses `@agent/core/secure-io`; do not add `node:fs` imports.
- Do not store raw confidential payload copies in public knowledge or broad observability logs.

## 4. Target Model

```text
Kyberion peer
  -> Mesh Hub directory and router
  -> durable delivery queue
  -> peer-messaging transport
  -> recipient inbox
  -> recipient acceptance policy
  -> A2A task contract OR WorkItem proposal OR user approval
```

### 4.1 Core records

| Record | Responsibility | Required fields |
|---|---|---|
| `PeerRegistration` | Stable peer identity and enrollment | `peer_id`, `tenant_id`, endpoint reference, key reference, status, registered_at |
| `PeerPresence` | Short-lived liveness and availability | `peer_id`, `heartbeat_at`, `expires_at`, health, capacity, receive modes |
| `CapabilityAdvertisement` | What a peer may receive | `capability_id`, version, roles, request kinds, approval policy, visibility |
| `MeshRequest` | A typed request prior to delivery | sender, target selector, intent, payload reference, TTL, idempotency key |
| `DeliveryRecord` | Queue and acknowledgement state | message ID, attempt count, route, status, retry time, failure class |
| `TopicSubscription` | Explicit scoped fan-out membership | topic, peer ID, tenant, filters, expiry, policy version |
| `RouteDecision` | Explainable recipient selection | candidates, exclusions, selected recipients, policy verdict, correlation ID |

### 4.2 Selector kinds

- `peer`: exact `peer_id`; use for an explicit handoff.
- `role`: a declared role such as `security-reviewer`; select one eligible peer unless the request explicitly permits fan-out.
- `capability`: a declared capability such as `document.review`; select by policy, readiness, and capacity.
- `topic`: publish only to explicitly authorized subscribers.

`broadcast` is not a selector kind. It is represented as a topic with tenant, authorization, maximum recipients, TTL, and payload-tier constraints.

### 4.3 Delivery lifecycle

```text
draft -> accepted -> routed -> queued -> dispatched -> acknowledged
                                      |              |
                                      v              v
                                  expired       completed / rejected
                                      |
                                      v
                                dead_lettered
```

`acknowledged` means transport receipt only. `completed` means the recipient emitted a separately validated result. Neither state grants execution authority.

## 5. Storage and Tiering

Use append-only runtime records and separate observability summaries.

- `active/shared/runtime/mesh-hub/registrations.jsonl`
- `active/shared/runtime/mesh-hub/presence.jsonl`
- `active/shared/runtime/mesh-hub/capabilities.jsonl`
- `active/shared/runtime/mesh-hub/deliveries.jsonl`
- `active/shared/runtime/mesh-hub/subscriptions.jsonl`
- `active/shared/runtime/mesh-hub/dead-letter.jsonl`
- `active/shared/observability/mesh-hub/events.jsonl`

Payload content must be stored only in the sender/recipient tier-authorized artifact store. Hub records contain payload metadata, hashes, and governed references. The observability stream contains identifiers, state transitions, and redacted reason codes only.

### 5.1 v1 persistence and concurrency rule

`appendGovernedArtifactJsonl()` uses a synchronous append helper but does not provide a cross-process file lock. Therefore v1 has exactly one Mesh Hub writer process per runtime root.

- Peer-facing processes submit typed commands to the Hub; they never append directly to `mesh-hub/*.jsonl`.
- The Hub serializes all mutation commands through one in-process command loop. It checks idempotency and writes the authoritative delivery record before returning `accepted`.
- The Hub uses governed append helpers only from that writer. JSONL is the durable event journal; read models and indexes are derived and may be rebuilt.
- A future multi-process or multi-host Hub requires a transactional store or a separately designed lock/lease protocol. Do not add an ad hoc lock file in this implementation.
- Task 3 must prove that concurrent `acceptMeshRequest()` calls with the same idempotency key create one delivery record.

## 6. Required Subagents and Assignment

Use six `gpt-5.4-mini` subagents. They do not edit concurrently unless their file scopes are disjoint. `gpt-5.5-medium` is the sole coordinator and integration owner.

| Agent | Role | Assigned task | Primary outputs | Dependencies |
|---|---|---|---|---|
| A1 | Contract engineer | Define schemas, types, and policy vocabulary | Mesh schemas, TypeScript types, schema tests | None |
| A2 | Directory engineer | Implement enrollment, directory query, capability ads, heartbeat expiry | registry and presence store/APIs/tests | A1 |
| A3 | Delivery engineer | Implement durable queue, idempotency, retry, expiry, and dead letter | delivery APIs/tests | A1 |
| A4 | Routing and integration engineer | Implement selector routing and recipient adapters | router, peer transport adapter, WorkItem/A2A proposal adapters/tests | A1, A2, A3 |
| A5 | Security reviewer | Perform independent threat-model and policy review | findings, required remediation tests | A1-A4 read-only until fixes are assigned |
| A6 | Integration test engineer | Build deterministic same-host scenarios and regression suite | E2E tests, operator inspection tests, release evidence | A1-A4, A5 remediation |

### Coordinator responsibilities: `gpt-5.5-medium`

- Freeze the v1 vocabulary and approve schema changes before implementation begins.
- Issue one task contract at a time per overlapping file scope.
- Reconcile A1-A4 outputs against existing `peer-messaging`, A2A, WorkItem, and mission-control contracts.
- Reject scope expansion into federation, external networking, or remote execution.
- Turn A5 findings into bounded remediation tasks; do not let a reviewer directly make unrelated design changes.
- Run the release gate and make the final go/no-go decision.

## 7. Implementation Sequence for GPT-5.4 mini

Every task is one patch. Read the listed current code and tests before editing. Run the focused tests after every patch; stop on failure.

### Task 1: Establish Mesh Hub contracts

**Owner:** A1

**Goal:** Define closed, machine-validatable vocabulary before behavior changes.

**Add:**

- `knowledge/product/schemas/mesh-peer-registration.schema.json`
- `knowledge/product/schemas/mesh-peer-presence.schema.json`
- `knowledge/product/schemas/mesh-capability-advertisement.schema.json`
- `knowledge/product/schemas/mesh-request.schema.json`
- `knowledge/product/schemas/mesh-delivery-record.schema.json`
- `knowledge/product/schemas/mesh-topic-subscription.schema.json`
- `knowledge/product/governance/mesh-hub-policy.json`
- `libs/core/mesh-hub-contract.ts`
- focused schema/contract tests

**Acceptance:**

- Target selectors are only `peer`, `role`, `capability`, and `topic`.
- Every request has tenant scope, TTL, idempotency key, correlation ID, and payload classification/reference.
- Topic policy declares publisher/subscriber authorization and maximum fan-out.
- Schema or policy validation fails closed.

### Task 2: Implement directory, capability, and presence state

**Owner:** A2

**Goal:** Make peer identity and current availability queryable without using a static endpoint catalog as live truth.

**Add:**

- `libs/core/mesh-peer-directory.ts`
- `libs/core/mesh-peer-directory.test.ts`
- narrowly scoped exports in `libs/core/index.ts`

**Required APIs:**

- `registerMeshPeer(input)`
- `recordMeshHeartbeat(input)`
- `advertiseMeshCapabilities(input)`
- `resolveMeshPeer(peerId)`
- `listEligibleMeshPeers(selector, policyContext)`
- `expireMeshPresence(now)`

**Acceptance:**

- A valid heartbeat makes an enrolled peer eligible only until `expires_at`.
- Expired or revoked peers are excluded from routing.
- A peer cannot advertise a capability outside its enrolled allowlist.
- Static `peer-network.json` may bootstrap a local peer but cannot override live revocation or tenant policy.

### Task 3: Implement durable delivery

**Owner:** A3

**Goal:** Replace synchronous responder coupling with bounded queue semantics while retaining the existing transport adapter.

**Add:**

- `libs/core/mesh-message-broker.ts`
- `libs/core/mesh-message-broker.test.ts`

**Required APIs:**

- `acceptMeshRequest(request)`
- `enqueueMeshDelivery(routeDecision)`
- `claimDueMeshDeliveries(now, limit)`
- `acknowledgeMeshDelivery(deliveryId, receipt)`
- `rejectMeshDelivery(deliveryId, reason)`
- `retryMeshDelivery(deliveryId, now)`
- `expireMeshDeliveries(now)`
- `listMeshDeadLetters(filter)`
- `MeshHubCommandLoop` or an equivalent single-writer serialization boundary

**Acceptance:**

- Same sender plus idempotency key does not create duplicate work.
- Retry is bounded by policy and uses deterministic backoff in tests.
- Expired messages never dispatch.
- Terminal delivery failures are retained in a redacted dead-letter record.
- Queue acceptance returns promptly; no LLM call or long-running responder runs in the HTTP receive path.
- Concurrent accepts are serialized; identical idempotency keys create exactly one durable delivery record.
- The authoritative journal append completes before an `accepted` acknowledgement is returned.

### Task 4: Implement policy-aware routing and topic delivery

**Owner:** A4

**Goal:** Select eligible peers transparently and support controlled fan-out.

**Add:**

- `libs/core/mesh-router.ts`
- `libs/core/mesh-topic-registry.ts`
- corresponding focused tests

**Required behavior:**

- Exact peer routing validates tenant, enrollment, presence, and recipient capability.
- Role/capability routing returns an explainable ranking and selects one recipient by default.
- Topic routing requires an explicit subscription and enforces maximum fan-out.
- A route decision records candidates, exclusions, selected recipients, and reason codes.
- Missing or ambiguous candidates return a non-mutating `no_eligible_peer` or `requires_operator_selection` result.

**Prohibited behavior:**

- Do not route based on arbitrary prompt text.
- Do not use peer payload content as policy configuration.
- Do not treat a topic subscriber as authorized to receive a higher data tier.

### Task 5: Connect delivery to existing mechanisms without bypassing authority

**Owner:** A4, after Task 4

**Goal:** Use existing systems at the recipient boundary without changing their ownership model.

**Add:**

- `libs/core/mesh-hub-peer-messaging-adapter.ts`
- `libs/core/mesh-hub-peer-messaging-adapter.test.ts`
- focused adapter tests

**Compatibility boundary:**

- Implement `MeshHubPeerMessagingAdapter` as a new decorator/adapter around the public `peer-messaging` APIs.
- Do not change `PeerMessagingServer`, its synchronous responder behavior, or default endpoints in v1.
- Do not modify `work-coordination-peer.ts` or `a2a-bridge.ts` to accept Hub traffic. Use new recipient-side proposal adapters that call their existing public contracts after Hub acceptance.
- A change to an existing subsystem requires a coordinator-approved compatibility rationale and a regression test proving existing behavior is unchanged.

**Required behavior:**

- The broker dispatches a signed envelope via `peer-messaging`.
- The recipient stores and validates the message before accepting it.
- A request may produce an A2A task proposal or WorkItem proposal, never automatic mission execution.
- `mission_controller` receives no new remote mutation path.
- Existing synchronous `PeerMessagingServer` behavior remains backward compatible; the Hub adapter is opt-in.

### Task 6: Operator inspection surface

**Owner:** A6

**Goal:** Let an operator diagnose the mesh without exposing payload content.

**Add:**

- read-only CLI or control-plane commands for peers, routes, deliveries, dead letters, and topics
- concise documentation in `knowledge/product/orchestration/`
- focused command/output tests

**Required output fields:**

- peer ID, tenant, presence state, heartbeat age, declared capabilities
- request/delivery ID, source/target selector, state, retry count, expiry, redacted reason
- route explanation and topic fan-out count

## 8. Review Plan

### Review 1: Contract and architecture review

**Owner:** Coordinator before Task 2

Confirm:

- no duplicate ownership with A2A, WorkItem, or mission control;
- every mutating record has tenant, identity, timestamp, correlation, and idempotency semantics;
- confidentiality classification is explicit;
- v1 does not require federation or public discovery.

### Review 2: Security review

**Owner:** A5 after Task 5

Threat-model at least:

- spoofed peer registration or heartbeat;
- replayed, duplicated, expired, or reordered message;
- capability escalation through advertisement or payload;
- unauthorized topic subscription/publish;
- cross-tenant routing and data-tier leakage;
- message loop, retry storm, and fan-out amplification;
- raw payload leakage through logs, route explanations, or dead letters;
- remote request attempting mission lifecycle mutation.

For each finding, record severity, exploit precondition, affected contract/code, and a testable remediation. High-severity findings block release.

### Review 3: Operator UX review

**Owner:** Coordinator with A6 evidence

Verify an operator can answer these without opening raw JSONL:

1. Which peers are currently eligible for a given capability?
2. Why was a particular peer selected or excluded?
3. Is a request queued, retrying, dead-lettered, or completed?
4. Does a delivery represent transport acceptance, work acceptance, or completed work?
5. Which topic recipients received a notification?

## 9. Test Plan

### Unit tests

- Schema rejection for missing tenant, TTL, idempotency, or data classification.
- Registration state machine: enrolled, revoked, expired, tenant mismatch.
- Presence expiry and capacity-aware eligibility.
- Capability advertisement allowlist and version validation.
- Deterministic peer/role/capability/topic routing.
- Duplicate request suppression and retry/backoff policy.
- Dead-letter creation and redaction.
- Topic authorization, fan-out limit, and subscription expiry.

### Integration tests

Use two same-host test peers with fake clocks and local signed transport:

1. Peer A registers and advertises `document.review`; Peer B resolves it by capability.
2. Peer A sends a request; Hub queues it; Peer B acknowledges it.
3. Replaying the same request yields no duplicate delivery or WorkItem proposal.
4. An expired heartbeat removes Peer B from eligibility.
5. A topic publish reaches only explicitly authorized subscribers.
6. A receiver rejects a message that requests direct mission execution.
7. A transport failure exhausts retries and produces a redacted dead letter.

### Regression tests

- Existing `peer-messaging` unit tests retain their synchronous compatibility behavior.
- Existing A2A tests retain signed local delegation behavior.
- Existing WorkItem lease/version tests retain ownership semantics.
- Contract schema suite includes all Mesh Hub schemas.

### Commands

Run every command from the repository root (`/Users/famao/kyberion`), where the root `package.json` and workspace configuration are present. Run focused tests after each task. At the release gate run:

```bash
pnpm run check:contract-schemas
pnpm exec vitest run libs/core/mesh-*.test.ts libs/core/peer-messaging.test.ts libs/core/a2a-bridge.test.ts libs/core/work-coordination*.test.ts
pnpm build
pnpm run validate
```

If a command name differs from the current package scripts, the coordinator must update this instruction and use the closest focused repository command rather than inventing a bypass.

## 10. Delivery Rules for GPT-5.4 mini

- One task, one patch, one focused test set.
- Do not edit files outside the assigned scope without coordinator approval.
- Prefer pure contract/store/router functions before HTTP or UI changes.
- Use existing secure I/O and governed artifact helpers.
- Do not add live-network, real-secret, or LLM dependencies to unit tests.
- Do not silently fall back from denied policy to a more permissive route.
- Return structured failure states; do not hide routing or delivery failures in prose-only logs.
- When blocked by an unresolved product decision, add an explicit `OPEN_QUESTION` to the task result and stop that task.
- Record resolved open decisions before assigning their dependent task, using the ADR rule in Section 11.1.

## 11. Open Decisions for the Coordinator

Resolve these before the corresponding implementation task starts:

1. Is the initial Hub process embedded in an existing control-plane runtime or exposed as a dedicated local service?
2. What is the canonical peer identity source for same-tenant enrollment: tenant registry, operator-managed catalog, or both?
3. Which capability vocabulary is eligible for remote routing in v1, and which capabilities are local-only?
4. What data classifications may traverse a same-tenant topic, and which require artifact-reference-only delivery?
5. What load signal is safe and useful for routing without turning the Hub into a scheduler?
6. Which approval modes are required before a recipient may convert a request into a WorkItem or A2A task?

Do not answer these with implementation guesses. Record a coordinator decision, update the policy/contract, then assign the dependent task.

### 11.1 ADR record rule

For each resolved decision, add a lightweight ADR under `knowledge/product/architecture/decisions/` before the dependent implementation task begins. Name it `YYYY-MM-DD-mesh-hub-<slug>.md` and include:

- decision and status;
- context and options considered;
- selected option and rationale;
- security, tenant, and data-tier consequences;
- affected schemas, policies, and task IDs;
- validation evidence and rollback or supersession condition.

The coordinator owns ADR approval. A task contract must cite the ADR path; an unrecorded decision is not a valid implementation assumption.

## 12. Completion Evidence

The coordinator must collect:

- schema validation output;
- focused unit and integration test output;
- release-gate command output;
- security review findings and remediation disposition;
- two-peer scenario receipt showing registration, routing, queueing, acknowledgement, and a rejected unsafe request;
- operator inspection output for a healthy peer, an expired peer, and a dead-lettered delivery;
- final decision record confirming that Hub delivery did not gain mission-state authority.

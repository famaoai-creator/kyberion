---
title: Agent Communication and Coordination Model
category: Architecture
tags: [architecture, agents, prompt, subagent, a2a, bridge, protocol, coordination]
importance: 9
author: Ecosystem Architect
last_updated: 2026-09-23
---

# Agent Communication and Coordination Model

Kyberion has several ways for agents and runtimes to exchange requests, context, and work. Choose them with one model that keeps participants, shared state, transport, trust, and authority distinct.

This is the canonical model. [Co-Session Coordination](./co-session-coordination.md) and the [Peer Network Catalog](../orchestration/peer-network.md) specify its main coordination surfaces. The [Multi-Provider Co-Execution Contract](../governance/multi-provider-coexecution-contract.md) specifies repository read/write authority.

## 1. Describe each communication path across independent dimensions

| Dimension       | Question                                     | Examples                                                                         |
| --------------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| Participant     | What is each endpoint?                       | Kyberion instance, provider CLI, delegated child agent, external surface         |
| Execution shape | How much autonomy and ownership is involved? | prompt, subagent, agent coordination                                             |
| Placement       | Which boundaries do participants cross?      | process, checkout, host, network, tenant                                         |
| Shared state    | What mutable state can both sides reach?     | none, checkout files, co-session journal, tenant runtime, WorkItem / mission     |
| Transport       | How does a request reach its recipient?      | backend call, local coordination files, signed HTTP peer message, managed bridge |
| Trust           | How are identity and scope established?      | provider identity, enrolled peer key, tenant, data classification, capability    |
| Authority       | What may a participant change?               | read, leased path, claimed work item, accepted proposal, mission lifecycle       |
| Durability      | What survives failure?                       | request, session, delivery journal, mission evidence                             |

Placement boundaries are independent:

- Same process: work runs inside one runtime process.
- Same checkout: participants can see the same repository working tree.
- Same host: processes run on one operating system host.
- Different host: a network boundary is crossed.
- Same tenant: data and peer policy resolve to one registered tenant scope.
- Runtime root: root used for mutable runtime and observability state.

Same host does not imply same checkout, runtime root, or owner. A localhost endpoint describes where a connection is routed; it does not authenticate the caller, prove the listener is the intended peer, or grant access to local files.

## 2. Execution shape is independent of transport

| Shape              | Use it when                                                                                                                                                        | Kyberion examples                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| prompt             | One short, inspectable request/response is enough.                                                                                                                 | Single reasoning call or structured transformation                  |
| subagent           | A child should own bounded, multi-step reasoning or repair.                                                                                                        | Reasoning backend delegation, task executor                         |
| agent coordination | Work needs shared state, handoff, durable ownership, recovery, or a boundary crossing requires governed participant, scope, acceptance, or authority coordination. | Co-Session, Peer Messaging / Mesh Hub, WorkItem and mission control |

A prompt or subagent can use a local or remote reasoning backend. An HTTP message is not automatically a coordinated task: it may only be a transport receipt. Choose coordination and authority from the work semantics, then select a transport that can enforce them.

### Intent routing rubric

Intent routing selects an execution shape from work semantics, not from an implementation detail. Use four signals:

| Signal   | Detects                                                                      |
| -------- | ---------------------------------------------------------------------------- |
| scope    | One artifact, several artifacts, or a durable flow                           |
| autonomy | Whether independent decomposition or bounded child ownership helps           |
| boundary | Whether ownership, runtime, surface, tenant, or trust boundaries are crossed |
| fanout   | Whether parallel workers or independent review improve the result            |

Use prompt for one inspectable, low-risk request; subagent for bounded autonomous work; agent coordination for shared mutable state, durable handoff, ownership, recovery, or a trust-boundary crossing that requires explicit participant, scope, acceptance, or authority coordination. A remote prompt or subagent backend alone does not require agent coordination. The routing decision is additive metadata on the intent contract. Governed defaults remain in knowledge/product/governance/work-policy.json. A decision can carry mode, scope, autonomy, boundary_crossing, fanout, owner/delegates, artifact_count, stop_condition, and rationale.

## 3. Communication patterns

| Pattern                                          | Participants and placement                                                         | Coordination surface                                                        | Shared-state and authority rules                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Kyberion ↔ Kyberion, different hosts**      | Separate Kyberion runtimes across a network; v1 peers share one registered tenant. | Peer Messaging; Mesh Hub for allowlisted collaboration requests.            | Enroll peers; authenticate signed envelopes; validate tenant, recipient, kind, classification, expiry, and policy. Transport acceptance is not work acceptance. The recipient accepts proposals locally. Mission lifecycle remains local to mission_controller.                                                                                                                       |
| **B. Kyberion ↔ Kyberion, same host**            | Separate Kyberion runtimes on one host, often reached through loopback.            | Same Peer Messaging contract as A, with same_host exposure when applicable. | Use distinct peer IDs, listener ports, secrets, and runtime roots/namespaces. Separate runtimes must not write the same peer journal or Mesh namespace as independent writers. Loopback is reachability, not authorization. If the participants are provider CLIs in one checkout, use C.                                                                                             |
| **C. Kyberion checkout ↔ local provider agents** | Multiple provider CLI processes work in one checkout, usually on one host.         | Co-Session for presence, path leases, blackboard notes, and handoffs.       | Co-Session is keyed to the checkout/session; participants have distinct IDs. Reads may run in parallel. A path lease coordinates mission-optional writes but is not authorization or enforced permission. Where a work-item claim applies, the claim remains the write authority. The mission owner alone changes .git and repository-wide configuration. No peer listener is needed. |
| **D. Orchestrator ↔ delegated child agent**      | A parent runtime starts a bounded child through a reasoning or task backend.       | Direct subagent delegation with an explicit task contract.                  | Minimize the child environment and grant only its assigned capability tier. Parent mission-owner authority is not inherited. Use a WorkItem or mission when work needs durable assignment, restart, independent acceptance, or evidence.                                                                                                                                              |

### Select the smallest suitable coordination surface

1. If one request can finish synchronously without shared mutable state, use prompt.
2. If one parent can define and inspect a bounded child task, use subagent.
3. If multiple local processes share a checkout and need coordination, use Co-Session.
4. If distinct Kyberion runtimes must exchange messages, use Peer Messaging; use Mesh Hub only for allowlisted collaboration requests.
5. If work needs durable cross-process ownership, retry/recovery, review, or evidence, represent it as a WorkItem and promote it to a mission when mission ownership or lifecycle is required.

Do not select peer HTTP merely because two processes run on one host. Do not use a shared checkout file as a remote transport. Keep the state owner explicit when moving between surfaces.

## 4. State ownership and collision control

| State                             | Coordination rule                                                                                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only repository context      | Providers may read in parallel, subject to tier and tenant authorization.                                                                                                                                        |
| Shared checkout file              | For mission-optional Co-Session work, a path lease is cooperative coordination, not authorization or enforcement. Where a work-item claim applies, it is the write authority; one owner writes a path at a time. |
| .git and repository configuration | Mission owner only. Co-Session participants and delegated child agents do not gain this authority.                                                                                                               |
| Peer / Mesh journals              | One configured runtime root and namespace owner per writer. Separate peers use unique peer IDs and isolated state roots/namespaces.                                                                              |
| Tenant confidential content       | Resolve through the registered tenant scope. Peer messages carry only policy-permitted references and metadata; confidential payloads do not enter public journals.                                              |
| Personal content                  | Not routable through the v1 Peer / Mesh path.                                                                                                                                                                    |

A process boundary is not a lock. A host boundary is not an ownership model. Use path leases, claims, unique state namespaces, or a single writer according to the state being changed.

## 5. Identity, authentication, authorization, and acceptance

Keep these checks separate and ordered:

1. **Reachability**: can the sender connect to the listener?
2. **Authentication**: can the recipient verify sender or provider identity?
3. **Scope authorization**: is that identity enrolled for this tenant, recipient, data classification, and request kind?
4. **Recipient acceptance**: does the recipient accept the proposed work or side effect?
5. **Execution authority**: which local WorkItem claim or mission owner may perform work and change lifecycle state?

Passing one check does not imply passing the next. A valid HMAC proves possession of a peer secret; it does not approve a proposal, grant shell or actuator access, or authorize remote mission lifecycle changes.

For v1 Peer / Mesh, keep same-tenant enrollment, explicit peer selection, request-kind allowlists, recipient validation, data-tier restrictions, expiry / replay protection, and local acceptance. A new cross-tenant or network-exposed control plane requires a new security and operations decision record.

## 6. Operational procedure

Before opening a communication path, record:

1. Participant IDs and participant types.
2. Whether they share a process, checkout, host, runtime root, tenant, or none of these.
3. Which files, journals, catalogs, and artifacts are shared or writable.
4. Request kind, data classification, side effects, and required recipient decision.
5. Identity credential, tenant scope, capability allowlist, writer/claim owner, and correlation ID.
6. Acknowledgement, retry/idempotency behavior, expiry, and recovery owner.

Then preflight the corresponding surface:

- **C / same checkout**: join one Co-Session, confirm participant IDs, acquire a path lease before writing, and leave .git to the mission owner.
- **B / same-host peer runtimes**: isolate peer IDs, ports, secrets, runtime roots/namespaces, verify tenant-scoped presence and capability, then send a low-risk typed message first.
- **A / remote peers**: complete same-tenant enrollment and endpoint/key checks, inspect healthy presence and advertised capability, send an explicit typed proposal, and let the recipient accept it locally.
- **D / delegated child**: define the child task, allowed tools/data, output artifact, stop condition, and review owner; do not pass the parent's privileged environment.

For peer operations, use [Same-Tenant Peer Quickstart](../orchestration/same-tenant-peer-quickstart.ja.md). For local same-checkout work, use [Co-Session Coordination](./co-session-coordination.md).

## 7. Extension contract

A new communication pattern or transport must:

- Fill the dimensions in §1 and map to a governed coordination owner.
- Reuse typed request and handoff vocabulary where work semantics match.
- Define stable participant identity, tenant and classification checks, capability and authority limits, correlation, acknowledgement, idempotency, expiry, and failure recovery.
- Define concurrency and single-writer behavior for every shared mutable store.
- Keep delivery receipt, recipient acceptance, work execution, and mission completion as distinct states.
- Include deterministic conformance coverage for wrong sender/recipient, tenant mismatch, duplicate or expired delivery, unauthorized action, resource collision, and restart/recovery.
- Update this model, relevant transport and coordination runbooks, and governance entry points together.

A dedicated network service, cross-tenant federation, automated peer scheduling, or remote mission lifecycle control is a material boundary change and requires a superseding ADR before implementation.

## 8. Implementation map

| Concern                                        | Existing owner                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Intent routing and execution shape             | knowledge/product/governance/work-policy.json and intent contracts                           |
| Bounded provider delegation                    | Reasoning backends, libs/core/task-executor.ts, provider permission profiles                 |
| Same-checkout local collaboration              | libs/core/co-session.ts, scripts/co_session.ts                                               |
| Kyberion-to-Kyberion transport                 | libs/core/peer-messaging.ts, scripts/peer_conversation_server.ts                             |
| Same-tenant discovery and allowlisted routing  | Mesh Hub modules and [Mesh Hub v1 ADR](./decisions/2026-06-24-mesh-hub-v1-boundaries.md)     |
| Durable task, ownership, and mission lifecycle | Work coordination and scripts/mission_controller.ts                                          |
| Cross-provider read/write contract             | [Multi-Provider Co-Execution Contract](../governance/multi-provider-coexecution-contract.md) |
| External surface ingress                       | Surface-specific bridges and viewer/tenant authorization                                     |

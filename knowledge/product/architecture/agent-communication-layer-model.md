---
title: Agent Communication and Coordination Model
category: Architecture
tags: [architecture, agents, prompt, subagent, a2a, bridge, protocol, coordination]
importance: 9
author: Ecosystem Architect
last_updated: 2026-11-12
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

Opt-in conversation auto replies are the one recipient-local behaviour accepted in advance: when the recipient operator lists a peer in `--auto-reply-peers`, that peer's conversation `message` / `reply` texts are answered with a tool-free LLM text reply, generated outside the receive path and bounded by a per-session turn cap and a per-peer budget. The opt-in is the recipient's acceptance for that text reply only; it never accepts a proposal, runs tools or actuators, or changes WorkItems or missions. See the [Peer Network Catalog](../orchestration/peer-network.md#conversation-auto-replies-opt-in) and the 2026-10-18 amendment of the [Mesh Hub v1 ADR](./decisions/2026-06-24-mesh-hub-v1-boundaries.md).

Typed peer tasks are how a peer asks for execution: the proposer names a task type, the recipient's own catalog (`connections/peer-tasks.json`) fixes the executor and the allowed proposers, receipt only records a pending task, and the recipient operator's local `accept` runs it as a `source: peer` WorkItem. The result returns artifact references (path, sha256, size) while the artifacts stay on the recipient; transport receipt, acceptance, execution and result delivery remain distinct recorded states. See [Typed peer tasks](../orchestration/peer-network.md#typed-peer-tasks).

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
- Reuse typed request and handoff vocabulary where work semantics match. Map every new message kind to a [coordination act](#11-coordination-acts) in `libs/core/mesh/coordination-act-map.ts`. `tests/coordination-act-boundary.test.ts` fails until you do.
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
| Bounded provider delegation                    | Reasoning backends, libs/core/task/task-executor.ts, provider permission profiles            |
| Same-checkout local collaboration              | libs/core/workforce/co-session.ts, scripts/co_session.ts                                     |
| Kyberion-to-Kyberion transport                 | libs/core/mesh/peer-messaging.ts, scripts/peer_conversation_server.ts                        |
| Same-tenant discovery and allowlisted routing  | Mesh Hub modules and [Mesh Hub v1 ADR](./decisions/2026-06-24-mesh-hub-v1-boundaries.md)     |
| Durable task, ownership, and mission lifecycle | Work coordination and scripts/mission_controller.ts                                          |
| Cross-provider read/write contract             | [Multi-Provider Co-Execution Contract](../governance/multi-provider-coexecution-contract.md) |
| External surface ingress                       | Surface-specific bridges and viewer/tenant authorization                                     |

For the module-level inventory — stores, entry points and live / half-retired status of each layer — see §9.

## 9. Messaging-layer map (2026-10-31)

The patterns in §3 are implemented by eight overlapping code layers (about 12,000 lines of non-test TypeScript in `libs/core`, counting only the main work-coordination file). This table records what each layer is for, who talks over it, where it keeps state, and whether it is still carrying traffic, so a merge or retirement starts from evidence.

How to read the evidence columns:

- **Direct importers** counts non-test, non-barrel files that import the module by path (`libs/core/index-part-*.ts` and `mesh/index.ts` excluded). Importers through the `@agent/core` barrel are not counted, so a low number means "check the barrel" rather than "orphan".
- **Last commit** is `git log -1 --format=%cs -- <module>` on 2026-10-31.
- Runtime stores are relative to the runtime root and partitioned by tenant where the column says `tenants/<t>`.

| Layer                                                                                     | Purpose                                                                                                                          | Participants / trust boundary                                                                           | Runtime store(s)                                                                                                                                                                                          | Main entry points                                                                                                                                           | Evidence (LOC · direct importers · last commit)                                                                                   | Status                                                                                                           |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Co-Session (`co-session.ts`)                                                              | Presence, path leases, blackboard notes and handoffs between provider CLIs (§3 C)                                                | Provider CLI processes in one checkout; cooperative, not an authorization boundary                      | `active/shared/runtime/co-sessions/`, `active/shared/observability/co-sessions/`                                                                                                                          | `pnpm kyberion co-session` (`scripts/co_session.ts`), provider hook `provider/co-session-hook.ts`, `scripts/co-session-monitor/`                            | 1,059 · 3 · 2026-10-21                                                                                                            | live                                                                                                             |
| Peer messaging (`peer-messaging.ts`)                                                      | Signed HMAC envelopes between enrolled Kyberion runtimes; peer catalog and enrollment (§3 A/B)                                   | Distinct runtimes, same tenant; enrolled peer key + tenant + request-kind allowlist                     | `active/shared/runtime/peer-messaging/tenants/<t>/peers/<local>/`; catalog `knowledge/confidential/<t>/connections/peer-network.json` (public sample `knowledge/product/orchestration/peer-network.json`) | `pnpm kyberion peer send` / `peer register`, `scripts/peer_conversation_server.ts` (listener)                                                               | 1,360 · 16 · 2026-10-18                                                                                                           | live (transport for the three peer layers below)                                                                 |
| Peer conversation (`peer-conversation.ts`)                                                | Multi-turn text sessions over peer messaging, with turn caps                                                                     | Same as peer messaging                                                                                  | `active/shared/runtime/peer-conversations/`                                                                                                                                                               | `pnpm kyberion peer conversation`, conversation server; read by `agent-collaboration-projection.ts`, terminal HUD, learning-signal sources                  | 1,054 · 7 · 2026-10-18                                                                                                            | live                                                                                                             |
| Peer auto reply (`peer-auto-reply.ts`)                                                    | Opt-in tool-free LLM replies to listed peers (§5)                                                                                | Recipient-local; opt-in per peer is the acceptance                                                      | `…/peer-messaging/tenants/<t>/peers/<local>/reply-jobs.jsonl`                                                                                                                                             | conversation server `--auto-reply-peers`                                                                                                                    | 997 · 2 · 2026-10-29                                                                                                              | live                                                                                                             |
| Peer task exchange (`peer-task-exchange.ts`)                                              | Typed peer tasks: propose → local accept → `source: peer` WorkItem → artifact-reference result (§5)                              | Same tenant; recipient catalog `connections/peer-tasks.json` fixes executor and allowed proposers       | `…/peer-messaging/tenants/<t>/peers/<local>/task-exchange.jsonl`                                                                                                                                          | `pnpm kyberion peer task`, conversation server                                                                                                              | 1,099 · 3 · 2026-10-18                                                                                                            | live                                                                                                             |
| Mesh hub — peer directory (`mesh-peer-directory.ts`)                                      | Tenant-scoped registrations, presence heartbeats and capability adverts                                                          | Same tenant; runtime presence required, catalog is bootstrap only                                       | `active/shared/runtime/mesh-hub/tenants/<t>/{registrations,presence,capabilities}.jsonl`                                                                                                                  | written by `scripts/peer_conversation_server.ts` (`registerMeshPeer`, `recordMeshHeartbeat`); read by `peer-runtime-recovery.ts`, `inspectMeshHub`          | 521 · 5 · 2026-10-09; files present in a live runtime root                                                                        | live                                                                                                             |
| Mesh hub — recipient proposals (`mesh-hub-peer-messaging-adapter.ts`)                     | Operator-selected recipient proposals for allowlisted request kinds; dispatches over peer messaging                              | Same tenant; operator selection, recipient acceptance                                                   | `active/shared/runtime/mesh-hub/tenants/<t>/adapters/<peer>/{proposals,proposal-decisions}.jsonl`                                                                                                         | conversation server, `pnpm kyberion peer collaboration`                                                                                                     | 639 · 3 · 2026-10-10                                                                                                              | live                                                                                                             |
| Mesh hub — broker + delivery driver (`mesh-message-broker.ts`, `mesh-delivery-driver.ts`) | Durable delivery journal with retry, expiry and dead letters                                                                     | Same tenant; single writer per runtime root                                                             | `active/shared/runtime/mesh-hub/tenants/<t>/{deliveries,dead-letter}.jsonl`, `active/shared/observability/mesh-hub/`                                                                                      | `pnpm kyberion mesh deliver` (claims due deliveries), doctor "Mesh delivery" line, `inspectMeshHub`                                                         | 973 + 272 · 2 + 1 · 2026-10-10 / 2026-10-09; **no production caller of `acceptMeshRequest` / `enqueueMeshDelivery`** (tests only) | half-retired: readers and driver are wired, nothing enqueues — candidate to retire or to wire behind the adapter |
| Mesh hub — inspection (`mesh-hub-inspection.ts`)                                          | Read-only operator view: peers, deliveries, dead letters                                                                         | Tenant required; read-only                                                                              | reads the three mesh-hub rows above                                                                                                                                                                       | `pnpm kyberion mesh-hub inspect`, `pnpm kyberion doctor`                                                                                                    | 182 · 2 · 2026-10-09                                                                                                              | live (peers view carries real data; deliveries view follows the broker's fate)                                   |
| A2A bridge (`a2a-bridge.ts`)                                                              | In-runtime agent-to-agent envelopes: spawns provider agents, routes asks, signs/verifies envelopes, delegation-chain attenuation | Orchestrator ↔ provider agents in one runtime (§3 D); NHI actor policy, delegation chain                | `active/shared/runtime/a2a-conversations/` (via `a2a-conversation-store.ts`); `active/shared/runtime/a2a/inbox` (network-actuator `a2a-transport.ts`)                                                     | `scripts/mission_controller.ts`, mission orchestration worker, surface runtime orchestrator, agent-actuator, chronos `/api/agents`, `pnpm kyberion a2a run` | 1,437 · 17 · 2026-10-26                                                                                                           | live                                                                                                             |
| A2A conversation store (`a2a-conversation-store.ts`)                                      | Mission-scoped transcript of A2A turns                                                                                           | Same as A2A bridge                                                                                      | `active/shared/runtime/a2a-conversations/`                                                                                                                                                                | `a2a-bridge.ts` only                                                                                                                                        | 255 · 1 · 2026-10-09                                                                                                              | live (private helper of A2A; candidate to fold into `a2a-bridge` ownership docs, not code)                       |
| ACP mediator (`acp-mediator.ts`)                                                          | Drives ACP-speaking agent CLIs (session, permission prompts, tool calls → actuators)                                             | Parent runtime ↔ child agent process (§3 D); tool calls resolved by `acp-tool-actuator-resolver.ts`     | none of its own (in-process session; evidence through the caller)                                                                                                                                         | `agent/agent-lifecycle.ts`, `provider/copilot-acp-reasoning-backend.ts`                                                                                     | 782 · 4 · 2026-10-09                                                                                                              | live (transport adapter under the A2A / agent-lifecycle path, not a peer layer)                                  |
| Work coordination (`workforce/work-coordination*.ts`)                                     | Durable WorkItems: claim / lease / event ledger, board catalog, peer-sourced items                                               | Any participant; claim holder is the write authority; mission lifecycle stays with `mission_controller` | `active/shared/runtime/work-coordination/`, `active/shared/observability/work-coordination/`                                                                                                              | `pnpm kyberion work …`, `mission_controller`, peer task acceptance (`work-coordination-peer.ts`), chronos work-coordination API                             | 1,585 (core file) · 95 · 2026-10-29                                                                                               | live (the ownership layer every other row hands off to)                                                          |

### Overlap and merge candidates

- **Peer conversation, auto reply and task exchange** share one transport (peer messaging), one listener (`peer_conversation_server.ts`) and one per-peer journal directory. They differ in what the recipient accepts, which §5 keeps distinct on purpose. Merge the plumbing (journal append/lock helpers, envelope dispatch) before merging any vocabulary.
- **Mesh hub** is now three live pieces (peer directory, recipient proposals, inspection) plus a broker with no producer. Either wire the adapter's accepted proposals through `acceptMeshRequest` (which would give peer collaboration retries and dead letters), or retire the broker, the delivery driver, `pnpm kyberion mesh deliver` and the doctor line together. Do not keep both half-states.
- **A2A bridge vs peer messaging**: A2A stays inside one runtime (orchestrator ↔ spawned agents); peer messaging crosses runtimes. The names suggest overlap; the trust boundary does not. Keep them separate.
- **ACP mediator** is a provider transport, not a coordination layer; list it under agent lifecycle rather than messaging in future maps.

### Mesh-hub topic residue (decided 2026-10-31)

The topic subscription writer (`subscribeMeshTopic`) and router (`mesh-router.ts`) were retired on 2026-10-01, leaving the read side `listMeshTopicSubscriptions` serving the `topics` section of `inspectMeshHub`, and `mesh-hub-policy.json` (already `documentation_only`, no loader). A trace found no code that writes `tenants/<t>/subscriptions.jsonl` (only the inspection test seeded it by hand) and no such file in a live runtime root. So the read side, the `topics` view of `pnpm mesh-hub:inspect`, the policy and its schema moved to `retired/` (see [`retired/README.md`](../../../retired/README.md#mesh-hub-topic-read-side-and-routing-policy-2026-10-31)). `inspectMeshHub` itself stays: its peers view reads data the conversation server writes, and the doctor uses its delivery counts. `MeshTopicSubscription` and `mesh-topic-subscription.schema.json` stay as part of the closed mesh contract vocabulary (`mesh-hub-contract.ts`, `tests/mesh-hub-contract.test.ts`).

## 10. Reasoning backends

`knowledge/product/governance/reasoning-backend-policy.json` lists 23 `allowed_modes`. Runtime evidence gathered for the 2026-10-31 legacy survey shows six in use: `claude-cli`, `claude-agent`, `codex-cli`, `agy-cli`, `grok-cli`, `devin-cli`.

Neither schema can carry a maturity marker today: `reasoning-backend-policy.schema.json` and `reasoning-provider-registry.schema.json` both set `additionalProperties: false`, with no `status` / `maturity` / documentation field per mode. The registry's `setup_hint` is free text but is shown to operators at runtime. So adding a marker means a schema change plus a loader change (`libs/core/reasoning/reasoning-provider-registry.ts`, and any surface that lists modes). That is not done here.

Recommendation, for a follow-up that may change the schema:

1. Add an optional `maturity: "verified" | "experimental"` to each provider descriptor in `knowledge/product/governance/reasoning-providers/<mode>.json` (the per-mode single source of truth, RS-01). Leave `allowed_modes` as the allowlist.
2. Mark these modes `experimental`: `ollama`, `vllm`, `lmstudio`, `llamacpp`, `mlx`, `localai`, `nemotron-api`, `openrouter`. Evidence: no operator session selected them. Their descriptors have not changed since the 2026-10-09 merge of #1014. Coverage is unit tests over the shared OpenAI-compatible adapter (between 2 and 12 test files mention each mode); there is no live conformance run against a real server.
3. Surface `experimental` in `pnpm kyberion doctor` / route doctor output and in auto-discovery logs, and never pick an `experimental` mode by auto-selection without an explicit env opt-in. Today the `KYBERION_*_URL` entries in `auto_select_env_priority` select these modes silently.
4. `gemini-cli`, `gemini-api`, `anthropic`, `grok-api`, `copilot`, `cursor-cli`, `opencode-cli`, `local` and `stub` are also unused in the recorded sessions, but each has its own adapter or a documented role (`stub` for hermetic tests, `anthropic` as the API-key fallback in AGENTS.md). Review them with operator input before marking them.

## 11. Coordination acts

Every layer in §9 names its messages in its own words: the A2A bridge has `performative`, peer messaging has `PeerMessageType`, Mesh Hub has request kinds, Co-Session has handoff kinds. Those words stay as they are, because envelopes are signed and ledgers store them. What is shared is the act behind each word. There are eight **coordination acts**, declared once in `libs/core/foundation/coordination-act.ts` (`COORDINATION_ACTS`):

| Act       | Meaning                                                                                | §5 stage                                                                                        |
| --------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `request` | Ask the recipient to do something                                                      | sent after 1–3; the work still needs 4 and 5                                                    |
| `propose` | Offer work or a side effect for the recipient to decide on                             | waits for 4; inert until a local accept                                                         |
| `accept`  | The recipient's own decision to take on a request, proposal or handoff                 | 4; executes nothing — execution is a stage-5 claim                                              |
| `reject`  | The recipient's own decision to decline                                                | 4                                                                                               |
| `inform`  | Tell something (notification, status, note, conversational turn); no decision expected | 1–3 only                                                                                        |
| `query`   | Ask for information, not for work (capability query)                                   | 3; no acceptance, no side effect                                                                |
| `result`  | Answer an earlier request or query: reply, capability answer, outcome of executed work | after 5; not mission completion, not the user-facing [Result](../../../docs/GLOSSARY.md#result) |
| `handoff` | Transfer responsibility for a piece of work                                            | ownership moves only after 4 and a stage-5 claim                                                |

No act carries execution authority. A message can ask for work, decide on it, or report it. Whether work runs is decided by the local WorkItem claim or the mission owner (stage 5).

### 11.1 Per-layer mapping

`libs/core/mesh/coordination-act-map.ts` maps every kind of every layer to one act, or to "not an act" with a reason. A kind that is a state, a category of stored record, or session control is not an act. Delivery receipt, recipient acceptance, execution and completion stay separate states (§7).

| Layer (declaration)                                                                      | Kind → act                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2A bridge `A2A_PERFORMATIVES` (`a2a-bridge.ts`, same set as `a2a-envelope.schema.json`) | `request`, `propose`, `inform`, `accept`, `reject`, `query`, `result` → the act of the same name                                                                                            |
| Peer messaging `PEER_MESSAGE_TYPES`                                                      | `request`→request · `reply`→result · `notification`→inform · `handoff`→handoff · `capability_query`→query · `capability_response`→result                                                    |
| Peer conversation `PEER_CONVERSATION_MESSAGE_KINDS`                                      | `message`→inform · `reply`→result · `handoff`→handoff · `status`→inform · `open`, `close`→not an act (session control)                                                                      |
| Typed peer task (`peer-task-exchange.ts`)                                                | `peer-task-request`→propose · `peer-task-result`→result · decision `accepted`→accept, `rejected`→reject · `PEER_TASK_STATES` and result `status`→not an act (recorded state, outcome field) |
| Mesh Hub `MESH_REQUEST_KINDS`                                                            | `review.request`→request · `workitem.claim`→request · `workitem.handoff`→handoff · `workitem.status_update`→inform · `capability.query`→query · `notification.publish`→inform               |
| Mesh Hub `MESH_DELIVERY_STATUSES`                                                        | all → not an act (delivery-journal state; its `accepted` is broker acceptance, not the recipient decision)                                                                                  |
| Mesh Hub recipient proposal                                                              | `proposal_kind` `a2a`, `workitem`→not an act (category of stored record) · decision `accepted`→accept, `rejected`→reject                                                                    |
| Work coordination peer command (`work-coordination-peer.ts`)                             | `claim_request`→request · `handoff_request`→handoff · `status_update`→inform (the command an accepted `workitem.*` proposal becomes)                                                        |
| Co-Session `CO_SESSION_HANDOFF_KINDS`                                                    | same as the Mesh Hub kinds it shares                                                                                                                                                        |
| Mission coordination bus `MissionCoordinationChannel`                                    | `task_contract`→request · `handoff`→handoff · `review`→request · `runtime_notice`→inform (the bus records acts performed elsewhere, for visibility)                                         |
| Agent execution port                                                                     | `AgentTaskEnvelope`→request · `AgentExecutionReceipt`→result · `AGENT_EXECUTION_RECEIPT_STATUSES`→not an act (execution state)                                                              |
| Discussion room `DiscussionPerformative`                                                 | `inform`, `summarize`→inform · `propose`, `challenge`, `agree`→not an act (a deliberation move about a position; a discussion `propose` is not a stage-4 proposal)                          |

Placements a reader may question: a conversation `message` is free text and is treated as `inform` even when it asks something, because nothing but the opt-in auto reply acts on it. `workitem.claim` is a request to claim, though Co-Session also uses it to record an intent. Bus `task_contract` has no producer today.

### 11.2 The gate

`tests/coordination-act-boundary.test.ts` is the only consumer of the mapping today. Nothing routes on acts at runtime. The gate fails when:

- a layer kind has no mapping, or a mapping names a kind the layer does not have. Each table is a `Record<LayerKind, …>` literal, so `tsc` rejects both for every layer. For layers that export a const array, the gate also compares the keys at runtime.
- a mapping targets something outside `COORDINATION_ACTS`, or a "not an act" entry has no reason.
- the Co-Session kinds and the Mesh Hub kinds they share are mapped differently, or a `workitem.*` kind and the peer command it becomes are mapped differently.
- a known copy of the A2A set drifts from `A2A_PERFORMATIVES`: the schema enum, the re-declared `A2AMessage` in `orchestrator-actuator/src/super-nerve/index.ts`, and the `performatives` set in `surface/surface-response-blocks.ts`.
- a module in `libs/core/{mesh,workforce,mission,agent,discussion}` or the network / orchestrator actuators declares a literal union or string array with two or more act-like members and is not registered. Registration names its table, or says why the set is not a coordination vocabulary.

The scan matches words, so a new vocabulary made of unrelated words, or one declared in another directory, gets past it. Kinds that are inline unions with no exported array are checked by the compiler only.

### 11.3 Three things called "A2A"

The name covers three separate mechanisms. Nothing connects them.

| Name in code                                                              | What it is                                                                                                | Traffic                                                               |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| A2A bridge (`libs/core/mesh/a2a-bridge.ts`)                               | In-runtime envelopes between the orchestrator and the provider agents it spawns (§3 D)                    | **yes, the only one**                                                 |
| `network:a2a_send` / `a2a_poll` (`network-actuator/src/a2a-transport.ts`) | A file-drop seam: writes and reads serialized envelopes under `active/shared/runtime/a2a/{inbox,outbox}`  | none: no pipeline, script or core module calls these ops (2026-11-12) |
| `a2a-message` in a Mesh Hub recipient proposal                            | A record stored with the proposal (`proposal_ref.payload`). Nothing executes it or sends it to the bridge | stored only                                                           |

Say which one you mean. "A2A" alone means the bridge.

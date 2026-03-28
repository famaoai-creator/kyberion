# Kyberion Glossary

This glossary translates Kyberion's ecosystem language into practical terms for contributors and operators.

## Core concepts

### Sovereign

The human owner/operator whose intent the ecosystem serves.

### Sovereign Entity

The autonomous agent persona defined by `AGENTS.md`. It is the acting identity of the system, not just a collection of scripts.

### Charter

The governance rules in `AGENTS.md`. These rules define safety, lifecycle, tier isolation, and execution constraints.

### Actuator

A concrete execution component under `libs/actuators/` that performs physical work such as file I/O, browser automation, network access, or orchestration.

### Procedure

Distilled operational knowledge or reusable method stored in the knowledge tier, often used to guide actuator behavior.

### ADF (Agentic Data Format)

A human-readable structured contract between reasoning and execution layers. In Kyberion, ADF is preferred over opaque script fragments.

### Intent

The human request expressed in natural language. In the intended UX, the user starts here rather than with actuator names or raw pipeline JSON.

### Resolution

Kyberion's structured interpretation of the user's intent. Resolution decides whether the request should become a direct reply, a browser operation, a task session, or a durable mission.

### Plan

A short human-readable execution summary such as `PDF を解析 -> レイアウトを復元 -> PPTX を生成`. Plans are what surfaces should show to users instead of raw ADF internals.

### Result

The user-facing outcome of execution: an answer, artifact, approval request, or concrete next step.

### Operator Interaction Packet

A human-facing interaction contract that carries clarification prompts, status summaries, delivery summaries, and recommended next actions without exposing raw internal execution details.

### Mission

A bounded unit of work with lifecycle state, evidence, and history. Mission operations are managed through `scripts/mission_controller.ts`.

### Task Session

A lighter-weight durable execution contract used for conversational work such as document generation, service inspection, capture flows, and interactive browser assistance.

### Project

The long-lived container of meaning around a body of work. A project can own repositories, missions, task sessions, artifacts, service bindings, and vault references.

### Outcome

The structured result Kyberion is trying to return for a request, such as `artifact:pptx`, `service_summary`, `browser_navigation`, or `knowledge_answer`.

### Artifact

The concrete output of work: a file, summary, delivery record, approval record, or other governed result object.

### Project Operating System

A document/control model that treats project artifacts as an operating system for decision-making, delivery, validation, and transfer rather than as a loose bundle of documents.

### Enterprise Operating Kernel

The top-level framing of Kyberion as a system where leadership provides intent and approval while the platform resolves, executes, accounts for, and learns from work.

### Mission Lease

A durable authority grant over a mission, task, bridge, or resource. Leases define who currently holds control and when that control expires.

### Task Contract

A structured unit of delegated work inside a mission. Task contracts define objective, write scope, expected outputs, and acceptance criteria.

### KSMC (Kyberion Sovereign Mission Controller)

The mission lifecycle controller referenced in the charter. It handles mission start, checkpoints, finish, and transactional safeguards.

## Lifecycle terms

### Onboarding

The phase where environment safety and identity are established, typically via `pnpm onboard`.

### Alignment

The planning and intent-definition phase. Work should not begin physically until goals and strategy are clear.

### Recovery & Resilience

The automatic resume/self-healing phase entered when a stale `.kyberion.lock` or interrupted mission state is detected.

### Mission Execution

The phase where actual changes are made and validated.

### Review & Distillation

The cleanup and learning phase where results are preserved as reusable wisdom.

## Architecture terms

### Brain

The reasoning/planning layer that interprets intent, chooses procedures, and shapes execution.

### Intent Layer

The human-facing layer where requests, clarification, status explanations, and next actions are handled.

### Control Layer

The operational governance layer where missions, projects, phases, gates, leases, and ledgers are managed.

### Knowledge Layer

The reusable layer for procedures, schemas, templates, policies, catalogs, and profiles.

### KnowledgeHint

Structured hint stored in `knowledge/public/procedures/hints/`. Contains topic, hint text, source, confidence score, and tags. Queryable at runtime by actuators.

### Spinal Cord

The actuator layer that performs the physical work chosen by the reasoning layer.

### Execution Layer

The deterministic layer where actuators, pipelines, generated plans, and governed artifact output run.

### Feedback Loop

Automated mechanism that connects execution results (Traces) back into the knowledge layer (Hints) and schedule management. Implements closed-loop between Phase 4 (Execution) and Phase 5 (Review).

### Memory Layer

The layer where evidence, reports, distillation output, and accumulated operational history are retained.

### Nerve System

Kyberion's background messaging, daemon, and observability model. See `docs/architecture/NERVE_SYSTEM_GUIDE.md`.

### Runtime Supervisor

The runtime ownership registry for PTY sessions, agent runtimes, and services. It tracks liveness, idle reaping, and resource snapshots.

### Packaging Contract

The repo-wide import boundary rule that keeps `pnpm` workspaces, Next, Node scripts, and tests aligned.

In practice this means:

- runtime code imports `@agent/core` through public package entrypoints
- `src/` and `dist/` are internal layout details
- `@agent/core` subpath imports are explicit and extensionless

Reference:
- `docs/PACKAGING_CONTRACT.md`

### Agent Runtime Supervisor

The operational front door for agent runtimes. It owns runtime ensure, ask, refresh, restart, stop, and prewarm flows so callers do not spawn providers independently.

### Reflex

A predefined automatic response, often expressed declaratively in ADF instead of TypeScript.

### Pulse

A shared runtime health/state signal, commonly surfaced through files like `active/shared/runtime/pulse.json`.

### Coordination Store

The mission-local and global storage model for task claims, handoffs, reviews, mailboxes, leases, and event streams.

### Control Plane

The layer that decides which mission, agent, or session should handle an external request. It is distinct from raw channel ingestion and from channel feedback delivery.

### OnErrorConfig

Pipeline step error handling configuration. Supports `skip` (continue), `abort` (stop), and `fallback` (execute recovery steps) strategies.

### Orchestration Worker

The deterministic event worker that reacts to mission control-plane events, prewarms agent runtimes, emits A2A task requests, and reconciles mission artifacts back into durable state.

### Gateway

A channel-facing ingress component that receives external events and normalizes them into governed internal artifacts. Examples include the Slack bridge and the Chronos API surface.

### Channel Outbox

A surface-scoped delivery queue under `active/shared/coordination/channels/<surface>/outbox/` used to return deterministic approved updates to external systems such as Slack and Chronos.

### Service Binding

A governed authenticated access contract for an external service. Service binding resolves service-scoped credentials or session material without turning the channel gateway into the credential source of truth.

Service bindings should be read together with:

- `Project`
  - the long-lived context that owns the relationship
- `Artifact`
  - what may be delivered through the relationship
- `Vault`
  - where the secret material is actually governed

### Specialist Team

The internal set of specialists Kyberion assigns to a request, such as a browser operator, document specialist, knowledge specialist, or mission lead. Users usually interact with one front-facing assistant while the specialist team works behind it.

### Evidence

The accountability substrate that links results back to source context, execution path, artifacts, approvals, and policy-relevant decisions.

### Delivery Actuator

An actuator that sends approved responses or UI events back to external channels. In the current model, `presence-actuator` is the primary delivery actuator for Slack-style channel feedback.

### DocumentDesignProtocol

Generic base type for document format design protocols. Implements a dual-layer model: semantic (editable) + raw (lossless preservation). Parameterized by format-specific semantic type.

### Artifact Actuator

A governed actuator for reading, writing, listing, and appending coordination and observability artifacts under approved runtime paths such as `active/shared/coordination/` and `active/shared/observability/`.

### Approval Actuator

A narrow actuator for creating, loading, deciding, and listing human approval requests without mixing that state machine into gateways or generic file operations.

### Chronos Gateway

The authenticated interactive control surface behind Chronos Mirror v2. It can manage runtime sessions and summarize delegations, but it is not the authoritative mission owner.

### Chronos Operator

The read-only Chronos access level mapped to `chronos_operator`. It can inspect mission state, recent control-plane activity, runtime leases, and delivery backlogs without mutating system state.

### Chronos Local Admin

The bounded local control-plane access level mapped to `chronos_localadmin`. It can invoke deterministic backend actions such as mission control, runtime remediation, and surface control, but it still does not become the mission authority itself.

### Channel

An external interaction context such as Slack or Chronos. A channel may have multiple concrete ports for ingress, egress, and streaming.

### Port

A concrete ingress or egress interface of a channel, described by role, directionality, transport, binding, durability, and approval mode.

### Surface Agent

A lightweight channel-local agent that improves interaction quality, context shaping, and handoff preparation without becoming the durable mission owner.

### Surface Outbox

The generic delivery contract shared by surfaces. Workers enqueue system updates there; bridges and control surfaces consume and render them asynchronously.

### Runtime Lease Doctor

The diagnostic view that inspects runtime lease metadata, finds stale/orphaned/error runtimes, and recommends or triggers remediation actions such as stop or restart.

### System Actuator

The actuator class for local short-lived shell, OS, and file-control operations. It is distinct from channel gateways and from authenticated service binding.

## Governance and storage terms

### Trace / Span / Event

Unified observability model inspired by OpenTelemetry. A Trace contains a tree of Spans (timed operations), each with Events (point-in-time occurrences) and Artifacts (screenshots, files).

### TraceContext

Mutable context for building structured execution traces during pipeline execution. Produces Trace objects with spans, events, artifacts, and knowledge references.

### Tier Isolation

The rule that Personal, Confidential, and Public data must stay physically separated.

### Pipeline Composability

The ability to reference sub-pipelines from within a pipeline using `ref` ops, with variable binding via `bind` and error handling via `on_error`.

### PipelineRef

A reference to an external pipeline JSON file that can be loaded and executed as a sub-pipeline within a parent pipeline.

### Personal Tier

Private, user-specific data under `knowledge/personal/`, including identity and private context.

### Confidential Tier

Sensitive organizational or client-specific data stored separately from public knowledge.

### Public Tier

Reusable shared knowledge, governance, and procedures intended for broad reuse within the ecosystem.

### Micro-Repo

An independently managed Git-backed mission workspace used to reduce leakage and improve rollback safety.

### Single-Owner, Multi-Worker

Kyberion's mission execution model: one owner agent controls mission state, while worker agents collaborate through delegated task leases.

### Sovereign Shield

The combined protection model around tier isolation, operational governance, and safe execution boundaries.

### Sudo Gate

The requirement for explicit sovereign approval before riskier or architectural actions are taken.

## Practical entrypoints

### Onboarding Wizard

`scripts/onboarding_wizard.ts`, the interactive setup for identity and initial user configuration.

### Capability Discovery

`scripts/capability_discovery.ts`, which inspects actuator manifests and environment compatibility.

### Mission Journal

`scripts/mission_journal.ts`, the human-readable view over recorded mission history.

### Global Actuator Index

`knowledge/public/orchestration/global_actuator_index.json`, the compact registry of runnable actuators used by the CLI.

### Legacy Component Index

`knowledge/public/orchestration/legacy_component_index.json`, the review queue for non-manifest-backed or compatibility-only components that should not be treated as the current runtime surface.

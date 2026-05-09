# Kyberion Component Map

Kyberion is a sovereign-agent ecosystem organized around a small number of high-leverage layers. This document is the practical "where do I start?" map for the current repository.

For a layer-oriented view of the concepts themselves, read:

- `knowledge/public/architecture/kyberion-canonical-concept-index.md`
- `docs/USER_EXPERIENCE_CONTRACT.md`
- `docs/OPERATOR_UX_GUIDE.md`
- `knowledge/public/architecture/kyberion-concept-map.md`
- `knowledge/public/architecture/llm-execution-boundary.md`
- `knowledge/public/architecture/actuator-contract-map.md`
- `knowledge/public/architecture/agent-communication-layer-model.md`
- `knowledge/public/architecture/enterprise-operating-kernel.md`
- `knowledge/public/architecture/ceo-ux.md`
- `knowledge/public/architecture/management-control-plane.md`
- `knowledge/public/architecture/corporate-memory-loop.md`
- `knowledge/public/architecture/project-mission-artifact-service-model.md`

## System at a glance

```text
Sovereign intent
  -> AGENTS.md governance and 5-phase lifecycle
  -> scripts/ and pipelines/ orchestration
  -> mission controller and coordination contracts
  -> libs/core shared runtime and secure I/O
  -> libs/actuators/* execution capabilities
  -> knowledge/* tiered memory and procedures
  -> active/ and presence/ runtime state and signals
  -> satellites/* external channels and edge integrations
```

## Layer model

Kyberion is easier to understand when concepts are separated into five layers:

- `Intent`
  - human requests, clarification, operator packets, next actions
- `Control`
  - missions, projects, phases, gates, ledgers
- `Knowledge`
  - procedures, schemas, templates, policies, catalogs
- `Execution`
  - actuators, pipelines, generated pipelines, delivery packs
- `Memory`
  - evidence, run reports, status reports, distillation, wisdom

Within those layers, the main durable containers are:

- `Project`
  - long-lived meaning, repositories, service bindings, artifacts, vault refs
- `Mission`
  - durable execution and audit trail
- `Task Session`
  - conversational bounded work
- `Artifact`
  - the concrete outcome
- `Service Binding`
  - the governed contract to an external system

This repo map focuses on the physical layout.
The concept map explains how those ideas fit together logically.

## Top-level directories

| Path | Role | Start here when you want to... |
| --- | --- | --- |
| `AGENTS.md` | Sovereign charter and operating rules | Understand the philosophy, constraints, and lifecycle |
| `docs/` | Human-facing guides | Learn setup, terminology, and architecture |
| `libs/core/` | Shared kernel utilities | Inspect secure I/O, path resolution, locks, CLI helpers |
| `libs/actuators/` | Execution "spinal cord" | See what the system can physically do |
| `knowledge/` | Tiered memory and procedures | Add guidance, playbooks, governance, and private context |
| `scripts/` | Entry-point commands | Run onboarding, missions, dashboards, and discovery tools |
| `pipelines/` | Declarative workflows | Review system diagnostics and repeatable flows |
| `plugins/` | Runtime guardrails and telemetry | Inspect policy enforcement and instrumentation |
| `satellites/` | External bridges | Connect Kyberion to platforms like Slack |
| `presence/` | Background sensing, dashboards, and control surfaces | Inspect pulse, display, sensory integrations, and Chronos Mirror v2 |
| `active/` | Mission/runtime workspace | Review live mission state and generated operational files |
| `schemas/` | Structured data contracts | Validate JSON-based ADF and ecosystem data |
| `tests/` | Cross-cutting tests | Run smoke and integration coverage |

## Core execution paths

### 1. Human onboarding

- `docs/INITIALIZATION.md`
- `docs/QUICKSTART.md`
- `scripts/onboarding_wizard.ts`

This path establishes identity files under `knowledge/personal/` and prepares the environment for mission work.

### 2. Mission orchestration

- `scripts/mission_controller.ts`
- `scripts/mission_journal.ts`
- `scripts/run_mission_orchestration_event_worker.ts`
- `scripts/run_agent_runtime_supervisor.ts`
- `libs/core/mission-orchestration-events.ts`
- `libs/core/mission-orchestration-worker.ts`
- `libs/core/agent-runtime-supervisor.ts`
- `libs/core/a2a-bridge.ts`
- `pipelines/vital-check.json`
- `active/missions/`
- `knowledge/public/architecture/agent-mission-control-model.md`
- `knowledge/public/architecture/mission-orchestration-control-plane.md`

This path manages mission lifecycle, mission ownership, task delegation, evidence, and journal/history views.
The current shape is:

- `mission_controller`
  - durable mission authority
- `mission-orchestration-worker`
  - event-driven deterministic orchestration
- `agent-runtime-supervisor`
  - runtime spawn/reuse/stop authority
- `a2a-bridge`
  - work delegation to agent runtimes

Mission orchestration should now be read together with the higher-order context model:

- project gives work its long-lived meaning
- mission gives work durable execution structure
- task session gives work conversational entry and bounded progress
- artifact records the outcome
- service binding governs external system interaction

For prompt assembly and operator-facing summaries, use the context
precedence protocol:

- `AGENTS.md` first
- mission / project governance second
- capability bundle and playbook summaries third
- live run context last

Local boot sequence:

```bash
pnpm agent-runtime:supervisor
pnpm mission:orchestrator
```

Operational entrypoints should stay at the top level of `scripts/`.
Ad hoc demos and one-off verification utilities should not live in the tracked operational script tree.
If temporary artifacts are needed, prefer governed runtime storage under `active/shared/` rather than adding disposable scripts to the repo.

### 3. Capability discovery and execution

- `scripts/capability_discovery.ts`
- `scripts/cli.ts`
- `scripts/check_esm_integrity.ts`
- `libs/actuators/*/manifest.json`
- `knowledge/public/governance/authority-roles/` (compatibility snapshot: `knowledge/public/governance/authority-role-index.json`)
- `knowledge/public/orchestration/team-roles/` (compatibility snapshot: `knowledge/public/orchestration/team-role-index.json`)
- `knowledge/public/orchestration/global_actuator_index.json` (compatibility snapshot)
- `libs/actuators/*`

This path tells users what is available and lets them run an actuator.

Runtime/package hygiene for this layer is enforced by `pnpm run check:esm`.

### 4. Channel ingress and interactive control

- `satellites/slack-bridge/`
- `satellites/imessage-bridge/`
- `satellites/telegram-bridge/`
- `presence/bridge/nexus-daemon.ts`
- `presence/displays/chronos-mirror-v2/`
- `knowledge/public/architecture/slack-chronos-control-model.md`

This path covers how external channels are normalized, routed, observed, and answered.
It also defines channel ports and Surface Agents that sit between human-facing surfaces and the durable mission/execution layer.

Current delivery model:

- mission/control-plane workers write deterministic updates to `active/shared/coordination/channels/<surface>/outbox/`
- channel bridges or control surfaces deliver/render those updates
- delivery observability lives under `active/shared/observability/channels/`

Chronos access modes:

- `readonly`
  - route-local observer mode for health, missions, runtimes, outbox, and diagnostics
- `localadmin`
  - route-local operator mode for deterministic mission/runtime/surface control actions

Local Chronos boot:

```bash
export KYBERION_LOCALHOST_AUTOADMIN=true
pnpm chronos:dev
```

Chronos does not directly own mission state. It delegates to:

- `mission_controller`
- `agent-runtime-supervisor`
- `surface_runtime`

### 5. Service binding and channel delivery

- `libs/core/service-binding.ts`
- `libs/actuators/service-actuator/`
- `libs/actuators/presence-actuator/`
- `libs/actuators/system-actuator/`
- `knowledge/public/orchestration/service-endpoints/` (compatibility snapshot: `service-endpoints.json`)

This path defines how authenticated external service access is separated from channel delivery and from local OS execution.
It is the practical boundary between "how we authenticate to a service", "how we deliver to a channel", and "how we run local commands".

Service binding should be treated as a first-class architecture concept.
Bindings connect projects, missions, task sessions, and artifacts to external systems without collapsing secrets into channel gateways or actuator-local config.

## Key library groups

### `libs/core/`

The kernel of the ecosystem. Important responsibilities:

- secure file/process helpers
- path resolution for tiered directories
- resource locks, leases, and concurrency guards
- CLI utilities and common runtime helpers
- runtime supervision for agent, PTY, and service ownership
- control-plane helpers for channel routing, feedback, and session-scoped artifacts
- mission orchestration worker and event contracts
- generic surface outbox and delivery helpers

If you are changing shared behavior or trying to follow AGENTS.md's secure-I/O rule, start here.

### `libs/actuators/*`

Actuators are the execution layer. Current major groups include:

- `file-actuator`: file operations and search
- `code-actuator`: code analysis/refactoring helpers
- `network-actuator`: secure API and A2A transport
- `wisdom-actuator`: knowledge distillation and evolution
- `knowledge/public/orchestration/specialists/` (compatibility snapshot: `specialist-catalog.json`)
- `media-actuator`: document and diagram generation
- `browser-actuator`: browser automation
- `system-actuator`: OS-level operations
  - local ephemeral shell/OS control only
- `modeling-actuator`: modeling and strategic reasoning support
- `service-actuator`: authenticated service binding and service-aware access
- `artifact-actuator`: governed coordination and observability artifact management
- `approval-actuator`: human approval request state transitions and decision handling
- `orchestrator-actuator`: mission/control-plane execution
- `process-actuator`: managed long-lived process ownership
- `presence-actuator`: channel delivery and in-session message dispatch
- `scripts/surface_runtime.ts`: operational lifecycle controller for long-running gateways and control surfaces

### Channel and service boundary

Kyberion uses four separate concepts here:

- `gateway`
  - receives external events
  - examples: `satellites/slack-bridge`, `satellites/imessage-bridge`, `satellites/telegram-bridge`, `chronos-mirror-v2` API routes
- `service binding`
  - resolves authenticated service access from governed secrets
  - examples: `libs/core/service-binding.ts`, `service-actuator`
- `delivery actuator`
  - sends approved responses or UI events back to a channel
  - example: `presence-actuator`
- `system actuator`
  - performs local short-lived shell/OS/file control
  - example: `system-actuator`

This means Slack and Chronos are not part of `system-actuator`.
They are human-facing gateways. Delivery belongs to `presence-actuator`, and authentication belongs to service binding.

Background surfaces and bridges are not started ad hoc. Their canonical startup manifests are `knowledge/public/governance/surfaces/*.json`, with `knowledge/public/governance/active-surfaces.json` as the generated compatibility snapshot. Lifecycle coordination runs through `scripts/surface_runtime.ts` plus `runtime-supervisor`.

## Mission control model

Kyberion uses a `single-owner, multi-worker` mission model.

- The mission is the durable control contract.
- One owner agent holds mission write authority.
- Worker agents collaborate through task contracts and scoped leases.
- Mission-local collaboration artifacts live under `active/missions/<tier>/<mission_id>/coordination/`.
- Global discovery, mailboxes, runtime locks, and observability summaries live under `active/shared/`.
- Channel-specific coordination and observability artifacts live under `active/shared/coordination/channels/` and `active/shared/observability/channels/`.
- Generic surface outbox artifacts live under `active/shared/coordination/channels/<surface>/outbox/`.

The authoritative architecture reference is:

- `knowledge/public/architecture/agent-mission-control-model.md`
- `knowledge/public/architecture/mission-orchestration-control-plane.md`

## Knowledge tiers

| Tier | Path | Purpose |
| --- | --- | --- |
| Personal | `knowledge/personal/` | Identity, private preferences, private missions |
| Confidential | `knowledge/confidential/` | Sensitive organizational knowledge |
| Public | `knowledge/public/` and shared docs | Reusable governance, procedures, and shared knowledge |

The charter assumes strict isolation between these tiers.

## Supporting architecture docs

- `docs/developer/architecture/AUTONOMY_SYSTEM_GUIDE.md`: shared memory, reflexes, dynamic permission, cluster concepts
- `docs/developer/architecture/NERVE_SYSTEM_GUIDE.md`: background daemons, messaging bus, observability, and policies
- `docs/PACKAGING_CONTRACT.md`: workspace/package import rules and boundary expectations
  - runtime code uses package imports only
  - white-box source imports in tests must stay explicitly whitelisted
- `README.md`: current operator-oriented summary of mission controller, orchestration worker, runtime supervisor, Slack, and Chronos
- `knowledge/public/architecture/agent-mission-control-model.md`: mission ownership, leases, coordination store, and explainable observability
- `knowledge/public/architecture/slack-chronos-control-model.md`: Slack ingress, Chronos control surfaces, channel outboxes, and observability boundaries
- `knowledge/public/architecture/channel-port-surface-model.md`: channels, ports, Surface Agents, and transport/directionality taxonomy
- `knowledge/public/architecture/slack-chronos-control-model.md`: also defines gateway, service binding, delivery actuator, and system actuator boundaries
- `knowledge/public/architecture/browser-actuator-v3.md`: Playwright engine, `snapshot + ref` interaction model, browser session leases, and test-export direction
- `dependency-graph.mmd`: repo-level dependency visualization

## Recommended reading order for new contributors

1. `README.md`
2. `AGENTS.md`
3. `docs/INITIALIZATION.md`
4. `docs/QUICKSTART.md`
5. This file
6. `docs/GLOSSARY.md`
7. `CAPABILITIES_GUIDE.md`

That sequence gives you the concept first, then the operating model, then the concrete places to work.

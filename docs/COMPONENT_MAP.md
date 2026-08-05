# Kyberion Component Map

Kyberion is a sovereign-agent ecosystem organized around a small number of high-leverage layers. This document is the practical "where do I start?" map for the current repository.

For a layer-oriented view of the concepts themselves, read:

- `knowledge/product/architecture/kyberion-canonical-concept-index.md`
- `docs/USER_EXPERIENCE_CONTRACT.md`
- `docs/OPERATOR_UX_GUIDE.md`
- `knowledge/product/architecture/kyberion-concept-map.md`
- `knowledge/product/architecture/llm-execution-boundary.md`
- `knowledge/product/architecture/actuator-contract-map.md`
- `knowledge/product/architecture/agent-communication-layer-model.md`
- `knowledge/product/architecture/enterprise-operating-kernel.md`
- `knowledge/product/architecture/ceo-ux.md`
- `knowledge/product/architecture/management-control-plane.md`
- `knowledge/product/architecture/corporate-memory-loop.md`
- `knowledge/product/architecture/project-mission-artifact-service-model.md`
- `knowledge/product/architecture/project-operational-state-store.md`

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

| Path              | Role                                                 | Start here when you want to...                                                                            |
| ----------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`       | Sovereign charter and operating rules                | Understand the philosophy, constraints, and lifecycle                                                     |
| `docs/`           | Human-facing guides                                  | Learn setup, terminology, and architecture                                                                |
| `libs/core/`      | Shared kernel utilities                              | Inspect secure I/O, path resolution, locks, CLI helpers                                                   |
| `libs/actuators/` | Execution "spinal cord"                              | See what the system can physically do                                                                     |
| `knowledge/`      | Tiered memory and procedures                         | Add guidance, playbooks, governance, and private context                                                  |
| `scripts/`        | Entry-point commands                                 | Run onboarding, missions, dashboards, and discovery tools                                                 |
| `pipelines/`      | Declarative workflows                                | Review system diagnostics and repeatable flows                                                            |
| `plugins/`        | Runtime guardrails and telemetry                     | Inspect policy enforcement and instrumentation                                                            |
| `satellites/`     | External bridges                                     | Connect Kyberion to Slack, Telegram, Discord, iMessage, or voice                                          |
| `presence/`       | Background sensing, dashboards, and control surfaces | Inspect pulse, sensors, bridges, and the UI surfaces under `presence/displays/` (map: `docs/SURFACES.md`) |
| `active/`         | Mission/runtime workspace and operational state      | Review live mission state, organization state (`active/organizations/`), and generated operational files  |
| `customer/`       | Customer overlay for FDE engagements                 | Layer customer-specific identity/config over `knowledge/personal/`                                        |
| `templates/`      | Reusable scaffolds and document templates            | Start a new pipeline, onboarding profile, or document from a template                                     |
| `schemas/`        | Structured data contracts                            | Validate JSON-based ADF and ecosystem data                                                                |
| `tests/`          | Cross-cutting tests                                  | Run smoke and integration coverage                                                                        |

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
- `docs/developer/AGENT_COMMS.md`
- `pipelines/vital-check.json`
- `active/missions/`
- `knowledge/product/architecture/agent-mission-control-model.md`
- `knowledge/product/architecture/mission-orchestration-control-plane.md`

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
- `knowledge/product/governance/authority-roles/` (compatibility snapshot: `knowledge/product/governance/authority-role-index.json`)
- `knowledge/product/orchestration/team-roles/` (compatibility snapshot: `knowledge/product/orchestration/team-role-index.json`)
- `knowledge/product/orchestration/global_actuator_index.json` (compatibility snapshot)
- `libs/actuators/*`

This path tells users what is available and lets them run an actuator.

Runtime/package hygiene for this layer is enforced by `pnpm run check:esm`.

### 4. Channel ingress and interactive control

- `satellites/slack-bridge/`
- `satellites/imessage-bridge/`
- `satellites/telegram-bridge/`
- `satellites/discord-bridge/`
- `satellites/voice-hub/`
- `presence/bridge/nexus-daemon.ts`
- `presence/bridge/terminal/` (terminal bridge)
- `presence/displays/chronos-mirror-v2/` (control tower, port 3000)
- `presence/displays/concierge/` (CEO secretary, port 3050)
- `presence/displays/presence-studio/` (companion workbench, port 3031)
- `presence/displays/computer-surface/` (local mirror, port 3040)
- `presence/displays/operator-surface/` (read-only audit monitor, port 3331)
- `presence/displays/terminal-hud/` (Ink TUI, `pnpm tui`)
- `knowledge/product/architecture/slack-chronos-control-model.md`
- `docs/SURFACES.md` (role map for all of the above)

This path covers how external channels are normalized, routed, observed, and answered.
It also defines channel ports and Surface Agents that sit between human-facing surfaces and the durable mission/execution layer.

Current delivery model:

- mission/control-plane workers write deterministic updates to `active/shared/coordination/channels/<surface>/outbox/`
- channel bridges or control surfaces deliver/render those updates
- delivery observability lives under `active/shared/observability/channels/`

Chronos access modes:

- `readonly`
  - observer mode for health, missions, runtimes, outbox, and diagnostics
- `localadmin`
  - operator mode for deterministic mission/runtime/surface control actions

Every route except `/api/healthz` resolves a `ViewerContext` fail-closed (viewer role + allowed tenant set; `src/lib/viewer-context.ts` + `src/middleware.ts`). Client-supplied `tenant` parameters can only narrow the viewer's allowed set. Enforcement is staged via `KYBERION_VIEWER_SCOPE=off|warn|enforce`; see `docs/developer/CHRONOS_VIEWER_SCOPE_OPERATIONS.ja.md`, including how to set `KYBERION_LOCALHOST_AUTOADMIN=false` to require tokens even on loopback.

Local Chronos boot:

```bash
export KYBERION_LOCALHOST_AUTOADMIN=true   # loopback auto-admin; set false to require tokens
pnpm chronos:dev
```

Chronos does not directly own mission state. It delegates to:

- `mission_controller`
- `agent-runtime-supervisor`
- `surface_runtime`

### 5. Service binding and channel delivery

- `libs/core/service-binding.ts`
- `libs/core/service-preset-registry.ts`
- `libs/actuators/service-actuator/`
- `libs/actuators/presence-actuator/`
- `libs/actuators/system-actuator/`
- `knowledge/product/orchestration/service-endpoints/` (compatibility snapshot: `service-endpoints.json`)
- `knowledge/product/orchestration/service-presets/`
- `knowledge/product/architecture/service-runtime-abstraction.md`

This path defines how authenticated external service access is separated from channel delivery and from local OS execution.
It is the practical boundary between "how we authenticate to a service", "how we deliver to a channel", and "how we run local commands".

Service naming is declarative and split across two catalogs:

- `service-endpoints`
  - canonical service identity, aliases, intent aliases, and endpoint-level metadata
- `service-presets`
  - operation templates for API / CLI / MCP / OAuth / reconcile flows

Execution is then split by runtime class:

- `tool-runtime`
  - CLI and executable lifecycle management
- `service-runtime`
  - long-lived local service lifecycle management
- `service-actuator`
  - auth, routing, binding, and reconciliation across the named service catalogs

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
- organization and tenancy: `organization-operating-model.ts`, `project-management.ts`, `work-coordination.ts` + `work-visibility.ts` (work-item context chain and visibility projections), `tenant-registry.ts`, `tenant-knowledge-retrieval.ts`, `peer-messaging.ts` (tenant peer mesh)
- identity and authorization: `agent-identity.ts` (NHI), `authority.ts`, `tier-guard.ts`, `delegation-chain.ts`
- history search: `history-search-index.ts` (SQLite FTS5, tier-isolated)

If you are changing shared behavior or trying to follow AGENTS.md's secure-I/O rule, start here.

### `libs/actuators/*`

Actuators are the execution layer. Current major groups include:

- `file-actuator`: file operations and search
- `code-actuator`: code analysis/refactoring helpers
- `network-actuator`: secure API and A2A transport
- `wisdom-actuator`: knowledge distillation and evolution
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

This list is the major groups only — the full, generated catalog of all actuators and their ops is [`CAPABILITIES_GUIDE.md`](../CAPABILITIES_GUIDE.md) (kept drift-free by `pnpm check:op-registry`). Specialist personas live in `knowledge/product/orchestration/specialists/` (snapshot: `specialist-catalog.json`); surface lifecycle control is `scripts/surface_runtime.ts`.

### `libs/shared-*`

Workspace packages shared across actuators and surfaces: `libs/shared-media` (media primitives), `libs/shared-nerve` (reflex engine and nerve-system helpers), `libs/shared-network` (network primitives), `libs/shared-vision` (vision helpers).

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

Background surfaces and bridges are not started ad hoc. Their canonical startup manifests are `knowledge/product/governance/surfaces/*.json`, with `knowledge/product/governance/active-surfaces.json` as the generated compatibility snapshot. Lifecycle coordination runs through `scripts/surface_runtime.ts` plus `runtime-supervisor`.

## Mission control model

Kyberion uses a `single-owner, multi-worker` mission model. Missions themselves sit inside the organization layer: every work item carries the canonical context chain `organization_id → tenant_slug → mission_id → project_id → task_id` (+ `work_shape`), and non-mission operating work (services, routine operations, incidents, cadences) is tracked by the organization operating model (`pnpm organization`).

- The mission is the durable control contract.
- One owner agent holds mission write authority.
- Worker agents collaborate through task contracts and scoped leases.
- Mission-local collaboration artifacts live under `active/missions/<tier>/<mission_id>/coordination/`.
- Global discovery, mailboxes, runtime locks, and observability summaries live under `active/shared/`.
- Channel-specific coordination and observability artifacts live under `active/shared/coordination/channels/` and `active/shared/observability/channels/`.
- Generic surface outbox artifacts live under `active/shared/coordination/channels/<surface>/outbox/`.

The authoritative architecture reference is:

- `knowledge/product/architecture/agent-mission-control-model.md`
- `knowledge/product/architecture/mission-orchestration-control-plane.md`

## Knowledge tiers

| Tier         | Path                                | Purpose                                                                                                                    |
| ------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Personal     | `knowledge/personal/`               | Identity, private preferences, private missions, tenant profiles (`tenants/`)                                              |
| Confidential | `knowledge/confidential/`           | Sensitive organizational knowledge, scoped per tenant: `{tenant-slug}/` roots, `tenant-groups/` shared prefixes, `common/` |
| Public       | `knowledge/public/` and shared docs | Reusable governance, procedures, and shared knowledge                                                                      |

The charter assumes strict isolation between these tiers. Within the confidential tier, tenant scope is a second isolation axis: cross-tenant access is deny-unless-brokered and audited (`knowledge/product/architecture/multi-tenant-operations.md`). Organization operating-model state follows the same tiers under `active/organizations/{tier}/{tenant}/{organization}/state/`.

## Supporting architecture docs

- `docs/developer/architecture/AUTONOMY_SYSTEM_GUIDE.md`: shared memory, reflexes, dynamic permission, cluster concepts
- `docs/developer/architecture/NERVE_SYSTEM_GUIDE.md`: background daemons, messaging bus, observability, and policies
- `docs/PACKAGING_CONTRACT.md`: workspace/package import rules and boundary expectations
  - runtime code uses package imports only
  - white-box source imports in tests must stay explicitly whitelisted
- `README.md`: product overview and quick start
- `knowledge/product/architecture/agent-mission-control-model.md`: mission ownership, leases, coordination store, and explainable observability
- `knowledge/product/architecture/multi-tenant-operations.md`: tenant isolation layers, brokered cross-tenant access, and tenant scope enforcement
- `docs/developer/CHRONOS_VIEWER_SCOPE_OPERATIONS.ja.md`: viewer principal, scoped tokens, and `KYBERION_VIEWER_SCOPE` staging
- `docs/developer/improvement-plans-2026-07/STATUS.ja.md`: the canonical implementation-status ledger for all improvement plans
- `knowledge/product/architecture/slack-chronos-control-model.md`: Slack ingress, Chronos control surfaces, channel outboxes, and observability boundaries; also defines gateway, service binding, delivery actuator, and system actuator boundaries
- `knowledge/product/architecture/channel-port-surface-model.md`: channels, ports, Surface Agents, and transport/directionality taxonomy
- `knowledge/product/architecture/browser-actuator-v3.md`: Playwright engine, `snapshot + ref` interaction model, browser session leases, and test-export direction
- `dependency-graph.mmd`: repo-level dependency visualization

## Recommended reading order for new contributors

1. `README.md`
2. `AGENTS.md`
3. `docs/INITIALIZATION.md`
4. `docs/QUICKSTART.md`
5. This file
6. `docs/SURFACES.md`
7. `docs/GLOSSARY.md`
8. `CAPABILITIES_GUIDE.md`

That sequence gives you the concept first, then the operating model, then the concrete places to work.

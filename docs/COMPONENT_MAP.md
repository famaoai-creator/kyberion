# Kyberion Component Map

Kyberion is a sovereign-agent ecosystem organized around a small number of high-leverage layers. This document is the practical "where do I start?" map for the current repository.

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
- `pipelines/vital-check.json`
- `active/missions/`
- `knowledge/public/architecture/agent-mission-control-model.md`

This path manages mission lifecycle, mission ownership, task delegation, evidence, and journal/history views.

### 3. Capability discovery and execution

- `scripts/capability_discovery.ts`
- `scripts/cli.ts`
- `knowledge/public/orchestration/global_skill_index.json`
- `libs/actuators/*`

This path tells users what is available and lets them run an actuator or skill.

### 4. Channel ingress and interactive control

- `satellites/slack-bridge/`
- `presence/bridge/nexus-daemon.ts`
- `presence/displays/chronos-mirror-v2/`
- `knowledge/public/architecture/slack-chronos-control-model.md`

This path covers how external channels are normalized, routed, observed, and answered.
It also defines channel ports and Surface Agents that sit between human-facing surfaces and the durable mission/execution layer.

## Key library groups

### `libs/core/`

The kernel of the ecosystem. Important responsibilities:

- secure file/process helpers
- path resolution for tiered directories
- resource locks, leases, and concurrency guards
- CLI utilities and common runtime helpers
- runtime supervision for agent, PTY, and service ownership
- control-plane helpers for channel routing, feedback, and session-scoped artifacts

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
- `modeling-actuator`: modeling and strategic reasoning support
- `service-actuator`: SaaS/API integration
- `orchestrator-actuator`: mission/control-plane execution
- `process-actuator`: managed long-lived process ownership

## Mission control model

Kyberion uses a `single-owner, multi-worker` mission model.

- The mission is the durable control contract.
- One owner agent holds mission write authority.
- Worker agents collaborate through task contracts and scoped leases.
- Mission-local collaboration artifacts live under `active/missions/<tier>/<mission_id>/coordination/`.
- Global discovery, mailboxes, runtime locks, and observability summaries live under `active/shared/`.
- Channel-specific coordination and observability artifacts live under `active/shared/coordination/channels/` and `active/shared/observability/channels/`.

The authoritative architecture reference is:

- `knowledge/public/architecture/agent-mission-control-model.md`

## Knowledge tiers

| Tier | Path | Purpose |
| --- | --- | --- |
| Personal | `knowledge/personal/` | Identity, private preferences, private missions |
| Confidential | `knowledge/confidential/` | Sensitive organizational knowledge |
| Public | `knowledge/public/` and shared docs | Reusable governance, procedures, and shared knowledge |

The charter assumes strict isolation between these tiers.

## Supporting architecture docs

- `docs/architecture/AUTONOMY_SYSTEM_GUIDE.md`: shared memory, reflexes, dynamic permission, cluster concepts
- `docs/architecture/NERVE_SYSTEM_GUIDE.md`: background daemons, messaging bus, observability, and policies
- `knowledge/public/architecture/agent-mission-control-model.md`: mission ownership, leases, coordination store, and explainable observability
- `knowledge/public/architecture/slack-chronos-control-model.md`: Slack ingress, Chronos control surfaces, channel outboxes, and observability boundaries
- `knowledge/public/architecture/channel-port-surface-model.md`: channels, ports, Surface Agents, and transport/directionality taxonomy
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

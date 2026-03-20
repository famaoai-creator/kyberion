# Kyberion

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub Repository](https://img.shields.io/badge/GitHub-kyberion-181717.svg?logo=github)](https://github.com/famaoai-creator/kyberion)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-339933.svg?logo=node.js)](https://nodejs.org/)

Kyberion is a **mission-first autonomous agent operating system**. It is a TypeScript monorepo that gives an AI agent:

- a structured execution body through `libs/actuators/`
- a tiered memory and governance layer through `knowledge/`
- a durable mission lifecycle through `mission_controller`
- a multi-agent orchestration model through events, A2A, and the runtime supervisor
- operator-facing control surfaces through Slack and Chronos Mirror

It is designed to be the runtime environment for an AI agent that performs real work: writing code, generating documents, calling APIs, and managing its own knowledge — all under a policy-driven governance layer.

## Key Concepts

| Concept | What it does |
|---|---|
| **Mission** | A unit of work with its own git repo, status lifecycle, and evidence trail |
| **Actuator** | An execution module (file I/O, browser automation, network, code generation, etc.) |
| **ADF** | Declarative JSON workflow that chains actuator operations — the primary interface for LLM agents |
| **A2A** | Agent-to-Agent messaging protocol for inter-agent communication |
| **Knowledge Tier** | Three-level information classification: `public`, `confidential`, `personal` |
| **Role** | An identity that determines permissions, procedures, and trust boundaries |
| **Distillation** | Extracting reusable knowledge from completed missions via LLM |

## Architecture

```
Sovereign intent
  -> surface ingress (Slack / Chronos / CLI)
  -> mission proposal or direct reply
  -> mission_controller (durable mission authority)
  -> mission-orchestration-worker (event-driven control plane)
  -> agent-runtime-supervisor (runtime authority)
  -> a2a-bridge (agent work delegation)
  -> libs/actuators/* (execution body)
  -> artifacts, events, and outbox delivery
```

| Path | Role |
|---|---|
| `libs/core/` | Shared kernel — secure I/O, path resolution, mission orchestration events, runtime supervisor, A2A bridge |
| `libs/actuators/` | Execution capabilities (file, browser, code, network, system, wisdom, media, etc.) |
| `knowledge/` | Tiered memory — `public/` (governance), `confidential/` (org-internal), `personal/` (gitignored) |
| `scripts/` | Entry points — mission controller, orchestration worker, runtime supervisor, dashboards, runtime surfaces |
| `pipelines/` | ADF workflow definitions |
| `active/` | Runtime workspace for missions, queues, and shared state (gitignored) |
| `satellites/` | External bridges such as Slack |
| `presence/displays/chronos-mirror-v2/` | Chronos operator control surface |

## Getting Started

```bash
git clone https://github.com/famaoai-creator/kyberion.git && cd kyberion
pnpm install
pnpm build
pnpm onboard                    # set up identity
pnpm run cli -- list            # explore actuators
```

To boot the local control plane:

```bash
pnpm agent-runtime:supervisor
pnpm mission:orchestrator
KYBERION_LOCALHOST_AUTOADMIN=true pnpm chronos:dev
```

## Missions

Missions are the primary unit of work. Each mission gets its own git micro-repo, status lifecycle, and evidence chain.

```
start → checkpoint (repeat) → verify → distill → finish
```

```bash
MC="node dist/scripts/mission_controller.js"
$MC help                                        # all commands
$MC start MY-FEATURE confidential               # create mission
$MC checkpoint task-1 "Implemented auth module"  # record progress
$MC verify MY-FEATURE verified "All tests pass"  # mark verified
$MC distill MY-FEATURE                           # extract knowledge via LLM
$MC finish MY-FEATURE                            # archive (--seal to encrypt)
$MC list active                                  # filter by status
$MC status MY-FEATURE                            # detailed view
```

**Status transitions** — invalid transitions are rejected at runtime:

```
planned ──► active ──► validating ──► distilling ──► completed ──► archived
              │                          ▲
              ├──► paused ──► active      │
              └──► failed ──► active      │
                                          │
              active ──► distilling ───────┘
```

### Orchestration Shape

Kyberion keeps the mission model simple and pushes flexibility into the control plane:

- `mission_controller`
  - the only durable mission authority
- `mission-orchestration-worker`
  - reacts to events and performs deterministic control-plane actions
- `agent-runtime-supervisor`
  - the only runtime spawn/reuse/stop authority
- `a2a-bridge`
  - routes work requests between agents

This gives a `single-owner, multi-worker` mission model:

- one mission
- one active owner
- many delegated workers
- event-driven retries and reconciliation

### Knowledge Distillation

The `distill` phase sends mission context (git log, evidence ledger, checkpoints) to an LLM, which extracts reusable knowledge as Markdown files with frontmatter.

LLM profiles are configurable per purpose (`heavy`/`standard`/`light`) in `wisdom-policy.json`, and per user in `my-identity.json`. Falls back to structural extraction when no LLM is available. See `knowledge/public/governance/` for configuration.

## ADF Pipelines & A2A

**ADF (Agentic Data Format)** is Kyberion's declarative workflow contract. An ADF pipeline chains actuator operations into a repeatable sequence and is validated as a JSON contract before execution.

```jsonc
// pipelines/vital-check.json
{
  "action": "pipeline",
  "name": "Ecosystem Vital Check",
  "steps": [
    { "op": "system:shell", "params": { "cmd": "...", "export_as": "status" } },
    { "op": "system:log",   "params": { "message": "Result: {{status}}" } }
  ]
}
```

Each `op` maps to an actuator capability (`system:shell`, `service:cli`, `file:read`, etc.). Steps export results via `export_as` and reference them with `{{variable}}` interpolation.

```bash
node dist/scripts/run_intent.js <intent_id>                               # resolve intent → ADF → execute
node dist/scripts/run_super_pipeline.js --input path/to/pipeline.json     # execute ADF directly
```

**A2A (Agent-to-Agent)** wraps ADF payloads in a messaging envelope with routing (`sender`, `receiver`, `performative`) and conversation tracking (`conversation_id`, `parent_id`). This enables external agents to request work from Kyberion and receive structured results.

```bash
node dist/scripts/run_a2a.js --input message.json
```

Schemas: `schemas/a2a-envelope.schema.json`, `schemas/super-nerve-pipeline.schema.json`, etc.

## Mission Control Model

Kyberion missions now follow a **single-owner, multi-worker** model.

- A mission is the durable contract and audit boundary.
- One owner agent holds mission write authority.
- Worker agents may collaborate through explicit task contracts and leases.
- Short-lived file exclusion uses resource locks; durable authority uses leases.

See `knowledge/public/architecture/agent-mission-control-model.md` for the authoritative model.

## Control Surfaces

### Slack

Slack acts as a governed ingress surface. It can:

- gather sovereign intent
- carry `mission_proposal -> confirmation -> mission issue`
- receive deterministic mission status updates from the shared outbox model

### Chronos Mirror

Chronos Mirror v2 is the operator-facing control surface. It provides:

- mission intelligence and recent orchestration events
- runtime lease doctor and remediation
- surface outbox visibility
- mission and surface control actions
- live mission-scoped agent conversation and A2A handoff trails

Access is intentionally split:

- `readonly`
  - inspect only
- `localadmin`
  - deterministic operator actions through backend controllers

For localhost development:

```bash
export KYBERION_LOCALHOST_AUTOADMIN=true
pnpm chronos:dev
```

See `knowledge/public/architecture/mission-orchestration-control-plane.md` for the control-plane model.

## Build and Packaging

Kyberion now separates package build from operational validation.

- `pnpm build`
  - builds package-local workspace artifacts first
  - then builds repo-level `dist/`
- operational validation and CI runtime checks execute built scripts under `dist/scripts/`
- runtime code must import shared kernel modules through `@agent/core` public entrypoints only

Examples:

```ts
import { safeReadFile } from "@agent/core/secure-io";
import { pathResolver } from "@agent/core/path-resolver";
```

Do not import from:

- `@agent/core/src/*`
- `@agent/core/dist/*`
- `../libs/core/*`

See [docs/PACKAGING_CONTRACT.md](./docs/PACKAGING_CONTRACT.md).

## Governance

### Three-Tier Knowledge

| Tier | Path | Access | Git |
|---|---|---|---|
| **Public** | `knowledge/public/` | All roles | Tracked |
| **Confidential** | `knowledge/confidential/` | Authorized roles | Gitignored |
| **Personal** | `knowledge/personal/` | Owner + privileged roles | Gitignored |

### Roles

A **role** (set via `MISSION_ROLE` env var) determines what the current agent can read/write, which procedures are loaded, and how trust boundaries are enforced. Each role has a procedure at `knowledge/public/roles/<role>/PROCEDURE.md`.

| Role | Scope |
|---|---|
| `ecosystem_architect` | Broad write across all tiers — system-level changes |
| `mission_controller` | Mission lifecycle — privileged read across all tiers |
| `sovereign_concierge` | User-facing — privileged read for context hydration |
| `software_developer` | Code and project files — scoped to `active/projects/` |
| `pmo_governance` | Mission governance and oversight |
| `qa_lead` | Testing and quality validation |
| ... | 27 roles total — see `knowledge/public/roles/` |

Permissions are defined in `knowledge/public/governance/security-policy.json` and enforced at runtime by `tier-guard`.

## Development

```bash
pnpm run typecheck             # type check
pnpm run test:unit             # unit tests
pnpm run test:coverage         # with coverage
pnpm run lint                  # lint
pnpm chronos:lint              # Chronos app lint
pnpm chronos:build             # Chronos production build
pnpm vital                     # ecosystem health check
```

## Repository Structure

| Path | Purpose |
|---|---|
| `AGENTS.md` | Operating charter and governance rules |
| `docs/` | Guides: HOWTO, QUICKSTART, COMPONENT_MAP, GLOSSARY |
| `libs/core/` | Shared runtime kernel (in-place compiled) |
| `libs/actuators/` | Execution modules (file, browser, code, network, etc.) |
| `knowledge/` | Tiered knowledge store with governance policies |
| `scripts/` | Entry points — mission controller, intent/A2A runners, CLI |
| `pipelines/` | Declarative ADF workflow definitions |
| `schemas/` | JSON schema contracts (ADF, A2A, missions, etc.) |
| `tests/` | Unit, integration, and smoke tests |
| `satellites/` | External platform bridges (Slack, etc.) |
| `presence/` | Background sensors and display dashboards |

## License

MIT

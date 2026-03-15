# Kyberion

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub Repository](https://img.shields.io/badge/GitHub-kyberion-181717.svg?logo=github)](https://github.com/famaoai-creator/kyberion)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-339933.svg?logo=node.js)](https://nodejs.org/)

Kyberion is an **autonomous agent operating system** — a TypeScript monorepo that gives an AI agent a structured body (actuators), a tiered memory (knowledge), and a governed mission lifecycle to operate within.

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
              ┌──────────────────────────────────┐
              │  scripts/  (Entry Points)         │
              │  mission_controller, run_intent,  │
              │  run_a2a, context_ranker, cli     │
              └──────────────┬───────────────────┘
                             │
              ┌──────────────▼───────────────────┐
              │  libs/core  (Shared Kernel)       │
              │  secure-io, path-resolver,        │
              │  tier-guard, mission-status,       │
              │  ledger, metrics, validators       │
              └──────────────┬───────────────────┘
                             │
           ┌─────────────────┼─────────────────┐
           │                 │                  │
  ┌────────▼───────┐ ┌──────▼───────┐ ┌───────▼──────┐
  │ libs/actuators/ │ │  knowledge/  │ │   active/    │
  │ file, browser,  │ │ public/      │ │ missions/    │
  │ code, network,  │ │ confidential/│ │ runtime/     │
  │ system, wisdom  │ │ personal/    │ │ shared/      │
  └────────────────┘ └──────────────┘ └──────────────┘
```

| Path | Role |
|---|---|
| `libs/core/` | Shared kernel — secure I/O, path resolution, tier-guard, mission status machine, ledger |
| `libs/actuators/` | Execution capabilities (file, browser, code, network, system, wisdom, media, etc.) |
| `knowledge/` | Tiered memory — `public/` (governance), `confidential/` (org-internal), `personal/` (gitignored) |
| `scripts/` | Entry points — mission controller, intent runner, A2A handler, context ranker |
| `pipelines/` | ADF workflow definitions |
| `active/` | Runtime workspace for missions, queues, and shared state (gitignored) |

## Getting Started

```bash
git clone https://github.com/famaoai-creator/kyberion.git && cd kyberion
pnpm install
pnpm run build && npx tsc -p libs/core/tsconfig.json
pnpm onboard                    # set up identity
pnpm run cli -- list            # explore actuators
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

### Knowledge Distillation

The `distill` phase sends mission context (git log, evidence ledger, checkpoints) to an LLM, which extracts reusable knowledge as Markdown files with frontmatter.

LLM profiles are configurable per purpose (`heavy`/`standard`/`light`) in `wisdom-policy.json`, and per user in `my-identity.json`. Falls back to structural extraction when no LLM is available. See `knowledge/public/governance/` for configuration.

## ADF Pipelines & A2A

**ADF (Agent Definition Format)** is Kyberion's declarative workflow language. An ADF pipeline chains actuator operations into a repeatable sequence — this is the primary way an LLM agent drives Kyberion programmatically (not intended for human CLI use).

```jsonc
// pipelines/vital-check.json
{
  "name": "Ecosystem Vital Check",
  "steps": [
    { "op": "system:shell", "params": { "cmd": "...", "export_as": "status" } },
    { "op": "system:log",   "params": { "message": "Result: {{status}}" } }
  ]
}
```

Each `op` maps to an actuator capability (`system:shell`, `service:cli`, `file:read`, etc.). Steps export results via `export_as` and reference them with `{{variable}}` interpolation.

```bash
pnpm exec tsx scripts/run_intent.ts <intent_id>                        # resolve intent → ADF → execute
pnpm exec tsx scripts/run_super_pipeline.ts --input path/to/pipeline.json  # execute ADF directly
```

**A2A (Agent-to-Agent)** wraps ADF payloads in a messaging envelope with routing (`sender`, `receiver`, `performative`) and conversation tracking (`conversation_id`, `parent_id`). This enables external agents to request work from Kyberion and receive structured results.

```bash
pnpm exec tsx scripts/run_a2a.ts --input message.json
```

Schemas: `schemas/a2a-envelope.schema.json`, `schemas/super-nerve-pipeline.schema.json`, etc.

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

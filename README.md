# Gemini Skills

> **Your AI doesn't just run tasks — it knows who you are, learns from every mission, and gets faster over time.**

Unlike generic agent frameworks, Gemini Skills is built around a single principle: **your AI should belong to you**. You define your identity once. It assembles the right team, routes your intent, executes with full auditability, and crystallizes successful patterns into reflexes — so it never has to think twice about the same problem.

**126 implemented skills** across 12 domains · TypeScript · pnpm workspaces · Node.js ≥ 20

---

## Why Gemini Skills Is Different

Most agent frameworks give you tools. Gemini Skills gives you an **AI that evolves with you**.

|                        | **LangChain / LangGraph** | **CrewAI / AutoGPT**    | **Gemini Skills**                                                   |
| ---------------------- | ------------------------- | ----------------------- | ------------------------------------------------------------------- |
| **Core model**         | Chain/graph composition   | Multi-agent task loops  | Sovereign identity + mission lifecycle                              |
| **Knowledge**          | RAG / external vector DB  | In-prompt memory        | 3-tier sovereign knowledge (Public / Confidential / Personal)       |
| **Same task twice?**   | Re-reasons from scratch   | Re-reasons from scratch | Runs a pre-crystallized pipeline — zero inference cost              |
| **Audit trail**        | Logs                      | Partial                 | Full evidence chain (`input_task.json` + `output.json`) per mission |
| **Who owns the data?** | Your DB vendor            | The platform            | You — enforced at the code level by `tier-guard`                    |

### The Three Differentiators

**1. Sovereignty** — Your identity (`knowledge/personal/my-identity.json`), your secrets, and your personas are owned and controlled by you. `tier-guard` physically prevents data from leaking across tiers at the code level — not just by policy.

**2. Evolution** — Every completed mission is distilled into a reusable `pipelines/*.yml`. The first time you do something, the AI reasons through it. The second time, it executes without thinking. This is the **Heuristic → Distillation → Deterministic** lifecycle, baked into the architecture.

**3. Evidence** — Every mission produces a tamper-evident `evidence/` trail. You can audit, replay, or archive any execution. This is not a log file — it is a structured record designed for regulatory review.

---

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  Phase 0: ALIGNMENT  (Brain — Pure Reasoning)               │
│  Intent extraction → context probe → TASK_BOARD.md          │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase 1: EXECUTION  (Spinal Cord — Automation)             │
│  Skill assembly → orchestrated execution → circuit breaker  │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase 2: DISTILLATION  (Learning & Evolution)              │
│  Outcome analysis → pipeline crystallization → pruning      │
└─────────────────────────────────────────────────────────────┘
```

The Brain and Spinal Cord are **physically separated**. The AI reasons in Phase 0 and produces a `MissionContract` (ADF/JSON). Phase 1 executes it deterministically — no further inference. This makes execution auditable, reproducible, and token-efficient.

---

## Quick Start

```bash
# 1. Clone and install
git clone <this-repo> && cd gemini-skills
pnpm install

# 2. Build
pnpm run build

# 3. Onboard — the Sovereign Concierge interviews you
#    and anchors your identity in knowledge/personal/my-identity.json
# (Simply tell your AI: "Initialize" or "Start onboarding")

# 4. Run a skill
pnpm run cli -- run security-scanner -- --target .

# 5. Run a full mission playbook
pnpm run pipeline -- pipelines/system-init-logic.yml
```

---

## Table of Contents

- [Why Gemini Skills Is Different](#why-gemini-skills-is-different)
- [How It Works](#how-it-works)
- [Quick Start](#quick-start)
- [The Cockpit: Chronos Mirror & Presence](#the-cockpit-chronos-mirror--presence)
- [3-Tier Knowledge Hierarchy](#3-tier-knowledge-hierarchy)
- [Mission Playbooks](#mission-playbooks)
- [Intent-Driven Routing](#intent-driven-routing)
- [Available Skills (126 Implemented)](#available-skills-126-implemented)
- [Conceptual Frameworks](#conceptual-frameworks)
- [Extending the Ecosystem](#extending-the-ecosystem)
- [CLI Tools](#cli-tools)
- [Development](#development)
- [Shared Libraries](#shared-libraries)
- [Contributing](#contributing)

---

## The Cockpit: Chronos Mirror & Presence

The ecosystem extends beyond the terminal.

### Chronos Mirror (Visual Dashboard)

Real-time overview of agent logic, mission evidence, and ecosystem health.

```bash
pnpm run mirror          # Launch dashboard
# Access: http://localhost:3030
```

Renders ACE Engine decision logs, performance metrics, and mission evidence in a browser UI.

### Presence Layer (Sensors)

The agent perceives external stimuli even while you are away:

- **Voice Hub** — Real-time microphone commands (TTS/STT loop)
- **Slack Adapter** — Asynchronous mobile/desktop interaction
- **Ecosystem Pulse** — Background file system event monitoring

Sensors inject _Whispers_ into the agent's awareness. `REALTIME` signals trigger immediate interrupts; `BATCH` signals are handled in the next interaction cycle.

→ See [`knowledge/architecture/presence-layer.md`](./knowledge/architecture/presence-layer.md)

---

## 3-Tier Knowledge Hierarchy

Your knowledge is yours. Higher tiers always override lower tiers. Data **never leaks downward** — enforced in code, not just policy.

| Tier             | Directory                 | Git           | Description                                         |
| ---------------- | ------------------------- | ------------- | --------------------------------------------------- |
| **Public**       | `knowledge/`              | Synced        | Shared standards, frameworks, tech-stack guides     |
| **Confidential** | `knowledge/confidential/` | Separate repo | Company/client secrets. Never enters Public outputs |
| **Personal**     | `knowledge/personal/`     | Never         | API keys, personal notes. Never leaves your machine |

**Precedence:** Personal > Confidential (Client) > Confidential (General) > Public

**Enforcement via `tier-guard`:**

- `validateInjection()` — validates data flow direction before any injection
- `scanForConfidentialMarkers()` — detects accidental inclusion of secrets (`API_KEY`, `PASSWORD`, `TOKEN`, …)

→ Full spec: [`knowledge/orchestration/knowledge-protocol.md`](./knowledge/orchestration/knowledge-protocol.md)

---

## Mission Playbooks

Playbooks are role-specific workflow recipes with **Victory Conditions** — a checklist of what must be true for the mission to succeed.

| Playbook                                                                          | Persona      | Key Skills                                                                                 | Output                                     |
| --------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| **[ceo-strategy](./knowledge/orchestration/mission-playbooks/ceo-strategy.md)**   | CEO          | scenario-multiverse-orchestrator, financial-modeling-maestro, competitive-intel-strategist | Executive summary (PPTX) + scenario report |
| **[product-audit](./knowledge/orchestration/mission-playbooks/product-audit.md)** | PM / Auditor | project-health-check, security-scanner, ux-auditor, pmo-governance-lead                    | Audit report + delivery presentation       |
| **[saas-roi](./knowledge/orchestration/mission-playbooks/saas-roi.md)**           | CEO          | financial-modeling-maestro, unit-economics-optimizer, competitive-intel-strategist         | 5-year P&L simulation + investment pitch   |

Add your own in `knowledge/orchestration/mission-playbooks/`.

---

## Intent-Driven Routing

Express your goals in natural language. The system maps trigger phrases to skill chains automatically via [`intent_mapping.yaml`](./knowledge/orchestration/meta-skills/intent_mapping.yaml):

| Intent                       | Trigger Phrases                          | Skill Chain                                                                                                    |
| ---------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Total Security Guarantee** | "audit security", "is this safe?"        | security-scanner → license-auditor → supply-chain-sentinel → post-quantum-shield → red-team-adversary          |
| **Business Launchpad**       | "new business idea", "launch product"    | competitive-intel-strategist → financial-modeling-maestro → unit-economics-optimizer → business-growth-planner |
| **Legacy Modernization**     | "refactor this mess", "modernize legacy" | codebase-mapper → cognitive-load-auditor → refactoring-engine → technology-porter                              |

---

## Available Skills (126 Implemented)

### 🧩 Core & Orchestration (`skills/core/`)

The agent's reasoning and execution backbone.

- **`mission-control`** — Central workflow orchestration with pipeline support
- **`intent-classifier`** — Maps natural language to skill chains
- **`self-evolution`** — Proposes improvements to the agent's own core
- **`mission-logic-engine`** — Deterministic pipeline runner (the Spinal Cord)
- **`self-healing-orchestrator`** — Detects and recovers from execution failures

### 🛠️ Engineering & DevOps (`skills/engineering/`)

- **`codebase-mapper`** — Multi-depth directory mapping
- **`test-genie`** — Autonomous test execution and analysis
- **`refactoring-engine`** — Large-scale technical debt reduction
- **`pr-architect`** — High-fidelity Pull Request generation
- **`dependency-lifeline`** — Dependency health and upgrade planning

### 🛡️ Audit, Security & Compliance (`skills/audit/`)

- **`security-scanner`** — Secret detection and vulnerability scanning
- **`compliance-officer`** — Regulatory mapping (SOC2, ISO, FISC)
- **`quality-scorer`** — IPA-based technical and textual quality evaluation
- **`license-auditor`** — Dependency license risk assessment
- **`post-quantum-shield`** — Post-quantum cryptography readiness audit

### 🔌 Service Connectors (`skills/connector/`)

- **`jira-agile-assistant`** — Sprint and issue management
- **`slack-communicator-pro`** — Automated team notifications
- **`google-workspace-integrator`** — Docs, Sheets, and Mail automation
- **`github-repo-auditor`** — Repository health and governance checks

### 📄 Media & Content Production (`skills/media/`)

- **`pdf-composer` / `ppt-artisan` / `word-artisan`** — Professional document creation
- **`doc-to-text`** — OCR-capable universal file extractor
- **`diagram-renderer`** — Logic-to-Diagram (Mermaid) visualization
- **`excel-artisan`** — Structured spreadsheet generation

### 🧠 Intelligence & Knowledge Management (`skills/intelligence/`)

- **`knowledge-harvester`** — Automated pattern extraction from repositories
- **`sovereign-memory`** — Persistent cross-mission fact management
- **`wisdom-distiller`** — Crystallizes successful missions into reusable pipelines
- **`dataset-curator`** — AI-ready data cleaning and structuring

### 🎨 UX, Interface & Voice (`skills/ux/`)

- **`ux-auditor`** — Visual and structural accessibility audits
- **`synthetic-user-persona`** — Automated persona-based UI testing
- **`localization-maestro`** — Multi-locale content adaptation

### 📊 Business Strategy & Executive Reporting (`skills/business/`)

- **`strategic-roadmap-planner`** — ROI-driven technology planning
- **`financial-modeling-maestro`** — P&L and cash flow simulation
- **`pmo-governance-lead`** — Cross-project risk and quality oversight
- **`tech-dd-analyst`** — Technical due diligence for M&A and investment

### 🛠️ Utilities (`skills/utilities/`)

39 general-purpose skills: API evolution management, data anonymization, chaos engineering, telemetry, template rendering, nonfunctional requirements, and more.

### 🏦 Finance, Lifestyle & Imagination (`skills/finance/`, `skills/lifestyle/`, `skills/imagination/`)

Domain-specific skills: JPX market analysis, land price analytics, Rakuten/SwitchBot integration, visual generation.

---

## Conceptual Frameworks

26 thinking models and governance guidelines (not executable skills) are documented in [`knowledge/frameworks/conceptual-frameworks.md`](./knowledge/frameworks/conceptual-frameworks.md):

- **Vision & Strategy**: north-star-guardian, scenario-multiverse-orchestrator
- **AI Governance & Safety**: kill-switch-guardian, human-in-the-loop-orchestrator
- **Culture & People**: creator-mentor, engineering-culture-analyst
- **Innovation**: future-evolution-oracle, innovation-scout
- **Quality**: aesthetic-elegance-auditor, cognitive-load-auditor
- **Risk & Resilience**: global-risk-intelligence-sentinel, sovereignty-maestro
- **Knowledge & Preservation**: sovereign-memory, intent-archivist

---

## Extending the Ecosystem

**Plugin System** — Every skill execution passes through `skill-wrapper`, which supports `beforeSkill` / `afterSkill` hooks from `.gemini-plugins.json`. Intercept, validate, or augment any skill without modifying core code.

```bash
pnpm run plugin -- install <package>     # Install from npm
pnpm run plugin -- register ./my-skill  # Register a local skill
pnpm run plugin -- list                 # List installed plugins
```

**External Knowledge** — Import third-party knowledge into `knowledge/external-wisdom/`. Ships with [Everything Claude Code](https://github.com/affaan-m/everything-claude-code) (MIT) as a reference.

---

## CLI Tools

```bash
# Run any skill
pnpm run cli -- run security-scanner -- --target .

# List all implemented skills
pnpm run cli -- list --status implemented

# Show skill info
pnpm run cli -- info knowledge-harvester

# Run a pipeline
pnpm run pipeline -- pipelines/daily-routine.yml

# Scaffold a new skill
pnpm run create-skill -- my-skill --description "Does something useful"

# Ecosystem health check
pnpm run doctor

# Quality audit (all skills)
pnpm run audit

# Performance benchmark
pnpm run benchmark
```

---

## Development

```bash
pnpm install              # Install dependencies
pnpm run build            # tsc → dist/
pnpm run typecheck        # Type check (no emit)
pnpm run lint             # ESLint
pnpm run validate         # Validate skill metadata + schemas
pnpm test                 # Smoke tests
pnpm run test:unit        # Unit tests (libs/core/)
pnpm run test:all         # Build + all tests
pnpm run generate-index   # Regenerate skill index
```

### Creating a New Skill

```bash
# CJS template (recommended for compatibility)
pnpm run create-skill -- my-skill --description "My new skill"

# TypeScript template
pnpm run create-skill -- my-ts-skill --template ts --description "TypeScript skill"
```

Templates: `templates/skill-template-cjs/` · `templates/skill-template-ts/`

### Project Structure

```
gemini-skills/
├── skills/          # 12 domains × 126 skills
├── libs/core/       # Shared library (@agent/core)
├── scripts/         # 83 system management scripts
├── knowledge/       # 3-Tier sovereign knowledge base
├── schemas/         # JSON Schema for skill I/O contracts
├── pipelines/       # Mission Logic YAML definitions
├── plugins/         # skill-wrapper hook plugins
├── presence/        # Sensor layer (Voice, Slack, Pulse)
├── templates/       # Skill scaffolding templates
├── tests/           # Smoke, integration, plugin tests
├── active/          # Live missions and project artifacts
└── vault/           # Read-only external reference data
```

---

## Shared Libraries

All skills import from `libs/core/` via the `@agent/core` alias:

| Module                  | Key Exports                                        | Purpose                          |
| ----------------------- | -------------------------------------------------- | -------------------------------- |
| `skill-wrapper.ts`      | `runSkill()`, `runSkillAsync()`                    | Standardized JSON output         |
| `secure-io.ts`          | `safeReadFile()`, `safeWriteFile()`                | Tier-aware safe file I/O         |
| `tier-guard.ts`         | `validateInjection()`, `validateWritePermission()` | Knowledge tier enforcement       |
| `orchestrator.ts`       | `runPipeline()`, `runParallel()`                   | Skill chain execution with retry |
| `metrics.ts`            | `metrics.record()`, `metrics.detectRegressions()`  | Execution metrics & health       |
| `knowledge-provider.ts` | `KnowledgeProvider`                                | Abstracted knowledge access      |
| `secret-guard.ts`       | `getSecret()`                                      | Secret retrieval & auto-masking  |
| `path-resolver.ts`      | `resolve()`, `skillDir()`                          | Logical path resolution          |
| `validators.ts`         | `requireArgs()`, `validateFilePath()`              | CLI argument validation          |
| `validate.ts`           | `validateInput()`, `validateOutput()`              | JSON Schema validation           |

### Skill I/O Contract

All skills conform to `schemas/skill-input.schema.json` and `schemas/skill-output.schema.json`.

```typescript
import { runSkill } from '@agent/core';

runSkill('my-skill', () => {
  return { result: 'data' };
});
```

---

## Knowledge Base

The `knowledge/` directory follows the [3-Tier Sovereign Model](#3-tier-knowledge-hierarchy):

- **`orchestration/`** — Playbooks, protocols, intent mapping
- **`frameworks/`** — 26 conceptual frameworks
- **`personalities/`** — Persona Matrix definitions
- **`tech-stack/`** — AWS, Box, Jira, Slack, Google guides
- **`security/`** — OWASP Top 10, secure coding patterns
- **`architecture/`** — Microservices, observability, service mesh
- **`fisc-compliance/`** — Financial security standards (Japan)
- **`devops/`** — CI/CD patterns, deployment strategies

---

## License

[MIT License](./LICENSE) — Copyright (c) 2026 famaoai.

_Certain industry standards in `knowledge/` are subject to their respective creators' rights. See [knowledge/README.md](./knowledge/README.md) for details._

## Acknowledgements

- **Everything Claude Code**: Rules and agent definitions in `knowledge/external-wisdom/everything-claude/` are derived from [everything-claude-code](https://github.com/affaan-m/everything-claude-code) by Affaan, under the [MIT License](./knowledge/external-wisdom/everything-claude/LICENSE).

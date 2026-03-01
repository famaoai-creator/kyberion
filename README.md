# Gemini Skills Monorepo

Your personal AI agent team — assembled around who you are and what you do.

**139 skills** (all implemented) + **26 conceptual frameworks** documented in `knowledge/frameworks/`.

## Philosophy: "Everyone Can Automate Their Own Work"

This is not a generic tool collection. It is a system where **you define your persona, and it assembles a personalized AI agent team for you**.

1. **Define your persona** — Run `node scripts/init_wizard.cjs` and select from 26+ specialized roles across 5 domains (Engineering, Leadership, Business, Governance, Support). The system configures itself around who you are.
2. **Get your skill team** — `skill-bundle-packager` assembles the right set of skills into a mission-ready bundle. Pre-built [Mission Playbooks](#mission-playbooks) (`ceo-strategy`, `product-audit`, `saas-roi`) provide ready-to-use workflows for common missions.
3. **Start automating** — Speak naturally. [Intent-driven routing](#intent-driven-routing) maps your requests to skill chains. `mission-control` orchestrates execution.

## 🚀 The Cockpit: Chronos Mirror & Presence

The ecosystem extends beyond the terminal, offering visual oversight and multi-channel sensory awareness.

### 1. Chronos Mirror (Display)
For a visual, real-time overview of the agent's logic and the ecosystem's health:
1.  **Launch**: `pnpm run mirror` (or `node scripts/cli.cjs system tasks --run-display`)
2.  **Access**: `http://localhost:3030`
3.  **Insights**: Renders ACE Engine decision logs, performance metrics, and mission evidence.

### 2. Presence Layer (Sensors)
The agent can perceive external stimuli from various channels, even while you are away.
- **Voice Hub**: Real-time auditory commands via microphone.
- **Slack Adapter**: Asynchronous interaction from mobile or desktop.
- **Ecosystem Pulse**: Background monitoring of file system events.

**Intervention**: Sensors inject "Whispers" into the agent's consciousness. High-priority signals (REALTIME) can trigger immediate interrupts, while BATCH signals are addressed in the next interaction.

See [`knowledge/architecture/presence-layer.md`](./knowledge/architecture/presence-layer.md) for details.

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Persona Selection          node scripts/init_wizard.cjs     │
│     (Engineer / CEO / PM)                                       │
└──────────────────┬──────────────────────────────────────────────┘
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. Skill Assembly             skill-bundle-packager            │
│     + Mission Playbooks        knowledge/orchestration/         │
│                                mission-playbooks/               │
└──────────────────┬──────────────────────────────────────────────┘
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. Intent Routing             intent_mapping.yaml              │
│     "audit security" ──→       security-scanner → license-      │
│                                auditor → supply-chain-sentinel  │
└──────────────────┬──────────────────────────────────────────────┘
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. Orchestrated Execution     scripts/lib/orchestrator.cjs     │
│     Sequential / Parallel      Pipeline YAML support            │
│     with retry logic                                            │
├─────────────────────────────────────────────────────────────────┤
│  ◆ Knowledge Tiers             Personal > Confidential > Public │
│    (scripts/lib/tier-guard.cjs)                                 │
│  ◆ Plugin Hooks                beforeSkill / afterSkill         │
│    (scripts/lib/skill-wrapper.cjs)                              │
└──────────────────┬──────────────────────────────────────────────┘
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. Standardized Output        JSON envelope via skill-wrapper  │
└─────────────────────────────────────────────────────────────────┘
```

## 📂 Project Structure

- **`active/`**: Ongoing missions, projects, and mission-specific evidence.
- **`skills/`**: The core ecosystem organized by domain:
  - **`core/`**: Fundamental orchestrators (Mission Control, Intent Classifier, Self-Evolution).
  - **`engineering/`**: Development and implementation tools.
  - **`audit/`**: Security, quality, and compliance scanning.
  - **`connector/`**: External service integrations.
  - **`media/`**: Document generation and processing.
  - **`intelligence/`**: Knowledge management and data processing.
  - \*\*`ux/`: User experience, visual, and voice interfaces.
  - **`business/`**: Strategy, P&L, and stakeholder reporting.
  - **`utilities/`**: Shared helpers and background daemons.
- **`knowledge/`**: The 3-tier sovereign knowledge base (Public, Confidential, Personal).
- **`vault/`**: Read-only source/reference materials (External assets).
- **`scripts/`**: Global system scripts and shared utilities.
- **`{skill-name}`**: Symbolic links for root-level compatibility.

## 3-Tier Knowledge Hierarchy

Each person can securely maintain their own knowledge base. Higher tiers always override lower tiers, and data never leaks downward.

| Tier             | Directory                 | Git        | Description                                                                |
| ---------------- | ------------------------- | ---------- | -------------------------------------------------------------------------- |
| **Public**       | `knowledge/`              | Synced     | Shared standards, frameworks, tech-stack guides. Safe for distribution.    |
| **Confidential** | `knowledge/confidential/` | Separate   | Company/client secrets. Sub-paths: `skills/<name>/` and `clients/<name>/`. |
| **Personal**     | `knowledge/personal/`     | Prohibited | Individual secrets — API keys, personal notes. Never leaves your machine.  |

**Precedence:** Personal > Confidential (Client) > Confidential (General) > Public

**Enforcement:** `tier-guard.cjs` prevents higher-tier data from leaking into lower-tier outputs:

- `validateInjection()` — Validates data flow direction before injection
- `scanForConfidentialMarkers()` — Detects accidental inclusion of secrets (API_KEY, PASSWORD, TOKEN, etc.)

See [`knowledge/orchestration/knowledge-protocol.md`](./knowledge/orchestration/knowledge-protocol.md) for the full specification.

## Mission Playbooks

Playbooks are role-specific workflow recipes with **Victory Conditions** — a checklist of what must be true for the mission to succeed.

| Playbook                                                                          | Persona    | Skills                                                                                                               | Output                                                |
| --------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **[ceo-strategy](./knowledge/orchestration/mission-playbooks/ceo-strategy.md)**   | CEO        | scenario-multiverse-orchestrator, financial-modeling-maestro, business-impact-analyzer, competitive-intel-strategist | Executive summary (PPTX) + Scenario comparison report |
| **[product-audit](./knowledge/orchestration/mission-playbooks/product-audit.md)** | PM/Auditor | project-health-check, security-scanner, ux-auditor, pmo-governance-lead                                              | Audit report + Delivery presentation                  |
| **[saas-roi](./knowledge/orchestration/mission-playbooks/saas-roi.md)**           | CEO        | financial-modeling-maestro, unit-economics-optimizer, competitive-intel-strategist                                   | 5-year P&L simulation + Investment pitch              |

Create your own playbooks in `knowledge/orchestration/mission-playbooks/` following the same format.

## Intent-Driven Routing

Express your goals in natural language. The system maps trigger phrases to skill chains automatically via [`intent_mapping.yaml`](./knowledge/orchestration/meta-skills/intent_mapping.yaml):

| Intent                       | Trigger Phrases                          | Skill Chain                                                                                                    |
| :--------------------------- | :--------------------------------------- | :------------------------------------------------------------------------------------------------------------- |
| **Total Security Guarantee** | "audit security", "is this safe?"        | security-scanner → license-auditor → supply-chain-sentinel → post-quantum-shield → red-team-adversary          |
| **Business Launchpad**       | "new business idea", "launch product"    | competitive-intel-strategist → financial-modeling-maestro → unit-economics-optimizer → business-growth-planner |
| **Legacy Modernization**     | "refactor this mess", "modernize legacy" | codebase-mapper → cognitive-load-auditor → refactoring-engine → technology-porter                              |

## Extending the Ecosystem

The system is designed for extensibility at every layer.

**Plugin System** — Every skill execution passes through `skill-wrapper.cjs`, which supports `beforeSkill` / `afterSkill` hooks loaded from `.gemini-plugins.json`. Intercept, validate, or augment any skill execution without modifying core code.

**Plugin Manager** — Install external skills or register local directories:

```bash
pnpm run plugin -- install <package>    # Install from npm
pnpm run plugin -- register ./my-skill  # Register a local skill
pnpm run plugin -- list                 # List installed plugins
```

**External Knowledge** — Import third-party knowledge into `knowledge/external-wisdom/`. The system ships with [Everything Claude Code](https://github.com/affaan-m/everything-claude-code) (MIT) as a reference implementation, providing 14 agent guides and language-specific coding rules.

---

## Table of Contents

- [Philosophy](#philosophy-everyone-can-automate-their-own-work)
- [How It Works](#how-it-works)
- [3-Tier Knowledge Hierarchy](#3-tier-knowledge-hierarchy)
- [Mission Playbooks](#mission-playbooks)
- [Intent-Driven Routing](#intent-driven-routing)
- [Extending the Ecosystem](#extending-the-ecosystem)
- [Quick Start](#quick-start)
- [How-To Guide](./HOWTO.md)
- [Project Status](#project-status)
- [Available Skills](#available-skills)
- [Conceptual Frameworks](#conceptual-frameworks)
- [Usage Scenarios](./SCENARIOS.md)
- [Knowledge Base](#knowledge-base)
- [CLI Tools](#cli-tools)
- [Development](#development)
- [Shared Libraries](#shared-libraries)
- [Contributing](#contributing)

## Quick Start

1. Clone this repository.
2. Run the interactive wizard: `node scripts/init_wizard.cjs` (installs dependencies and configures your role).
3. Validate: `pnpm run doctor`

## Project Status

Each skill has a `status` field in its `SKILL.md` frontmatter:

| Status        | Count | Meaning                                      |
| ------------- | ----- | -------------------------------------------- |
| `implemented` | 137   | Has runnable scripts in `scripts/` directory |

26 additional conceptual frameworks have been moved to `knowledge/frameworks/`.

---

## Available Skills (137 Implemented)

The ecosystem is now organized into functional namespaces for better governance, performance, and scalability.

### 🧩 Core & Orchestration (`skills/core/`)

Fundamental orchestrators that manage the agent's reasoning and execution logic.

- **`mission-control`**: Central workflow orchestration with pipeline support.
- **`intent-classifier`**: Maps natural language to skill chains.
- **`self-evolution`**: Enables the agent to propose improvements to its own core.

### 🛠️ Engineering & DevOps (`skills/engineering/`)

Tools for code analysis, testing, and structural refactoring.

- **`codebase-mapper`**: Multi-depth directory mapping.
- **`test-genie`**: Autonomous test execution and analysis.
- **`refactoring-engine`**: Large-scale technical debt reduction.
- **`pr-architect`**: High-fidelity Pull Request generation.

### 🛡️ Audit, Security & Compliance (`skills/audit/`)

Scanning and auditing tools to ensure safety and regulatory adherence.

- **`security-scanner`**: Secret detection and vulnerability scanning.
- **`compliance-officer`**: Regulatory mapping (SOC2, ISO, FISC).
- **`quality-scorer`**: IPA-based technical and textual quality evaluation.
- **`license-auditor`**: Dependency license risk assessment.

### 🔌 Service Connectors (`skills/connector/`)

High-fidelity integrations with enterprise collaboration and project tools.

- **`jira-agile-assistant`**: Sprint and issue management.
- **`slack-communicator-pro`**: Automated team notifications.
- **`google-workspace-integrator`**: Docs, Sheets, and Mail automation.

### 📄 Media & Content Production (`skills/media/`)

Universal document extraction and professional asset generation.

- **`pdf-composer` / `ppt-artisan` / `word-artisan`**: Professional document creation.
- **`doc-to-text`**: OCR-capable universal file extractor.
- **`diagram-renderer`**: Logic-to-Diagram (Mermaid) visualization.

### 🧠 Intelligence & Knowledge Management (`skills/intelligence/`)

The engine for the 3-tier sovereign knowledge base.

- **`knowledge-harvester`**: Automated pattern extraction from repositories.
- **`sovereign-memory`**: Persistent cross-mission fact management.
- **`dataset-curator`**: AI-ready data cleaning and structuring.

### 🎨 UX, Interface & Voice (`skills/ux/`)

Human-centric interaction and visual design auditing.

- **`ux-auditor`**: Visual and structural accessibility audits.
- **`voice-interface-maestro`**: Full TTS/STT voice control loop.
- **`synthetic-user-persona`**: Automated persona-based UI testing.

### 📊 Business Strategy & Executive Reporting (`skills/business/`)

Translating technical state into business value and strategic roadmaps.

- **`strategic-roadmap-planner`**: ROI-driven technology planning.
- **`financial-modeling-maestro`**: P&L and cash flow simulation.
- **`pmo-governance-lead`**: Cross-project risk and quality oversight.

---

## Conceptual Frameworks

26 conceptual frameworks have been consolidated in [`knowledge/frameworks/conceptual-frameworks.md`](./knowledge/frameworks/conceptual-frameworks.md). These are guidelines and thinking models, not executable skills:

- **Vision & Strategy**: north-star-guardian, visionary-ethos-keeper, scenario-multiverse-orchestrator
- **AI Governance & Safety**: kill-switch-guardian, human-in-the-loop-orchestrator, hive-mind-sync, ecosystem-federator
- **Culture & People**: creator-mentor, engineering-culture-analyst, human-capital-portfolio-analyst, community-health-guardian, public-relations-shield
- **Innovation & Future-Thinking**: future-evolution-oracle, innovation-scout, universal-polymath-engine, social-impact-forecaster
- **Quality & Craftsmanship**: aesthetic-elegance-auditor, cognitive-load-auditor, shadow-counselor
- **Risk & Resilience**: global-risk-intelligence-sentinel, sovereignty-maestro
- **Knowledge & Preservation**: deep-archive-librarian, intent-archivist, eternal-self-preservation-guardian, empathy-engine, persona-matrix-switcher

## Knowledge Base

Structured `knowledge/` directory following the [3-Tier Sovereign Model](#3-tier-knowledge-hierarchy):

- **`orchestration/`**: Playbooks, Protocols (3-Tier, MSC), Intent Mapping
- **`frameworks/`**: 26 conceptual frameworks (consolidated)
- **`personalities/`**: Persona Matrix definitions
- **`tech-stack/`**: AWS, Box, Jira, Slack, Google guides
- **`fisc-compliance/`**: Financial security standards (Japan)
- **`ceo/`**: Mission, Strategy, Finance
- **`schemas/`**: JSON Schema for skill I/O contracts
- **`security/`**: OWASP Top 10, secure coding patterns, vulnerability detection
- **`devops/`**: CI/CD pipeline patterns, deployment strategies
- **`architecture/`**: Microservices patterns, service communication, observability

## CLI Tools

### Unified CLI Runner

Run any skill from a single entry point:

```bash
# List all skills with status
pnpm run cli -- list

# List only implemented skills
pnpm run cli -- list --status implemented

# Run a skill
pnpm run cli -- run doc-type-classifier -- --input myfile.md

# Show skill info
pnpm run cli -- info data-transformer
```

### Performance Health Check

Diagnose ecosystem performance and detect regressions:

```bash
node scripts/check_performance.cjs
```

### Skill Creation Wizard

Scaffold a new skill from template:

```bash
# Create from CJS template (default)
pnpm run create-skill -- my-new-skill --description "Does something cool"

# Create from TypeScript template
pnpm run create-skill -- my-ts-skill --template ts --description "TypeScript skill"
```

### Performance Benchmarks

Measure syntax-check load times for all implemented skills:

```bash
pnpm run benchmark
# Results saved to evidence/benchmarks/
```

### Plugin Manager

Install external skills or register local skill directories:

```bash
# Install npm plugin
pnpm run plugin -- install some-plugin-package

# Register local skill
pnpm run plugin -- register ./path/to/skill

# List installed plugins
pnpm run plugin -- list

# Remove plugin
pnpm run plugin -- uninstall plugin-name
```

### Quality Audit

Check all implemented skills against a quality checklist:

```bash
# Table output
node scripts/audit_skills.cjs

# JSON output (for CI)
node scripts/audit_skills.cjs --format json
```

### Skill Pipelines

Chain skills together with data passing:

```bash
# Run a YAML pipeline
node scripts/run_pipeline.cjs pipelines/my-pipeline.yml
```

Pipeline YAML format:

```yaml
name: security-audit
pipeline:
  - skill: codebase-mapper
    params: { dir: '.' }
  - skill: security-scanner
    params: { input: '$prev.output' }
  - skill: html-reporter
    params: { input: '$prev.report' }
```

## Development

```bash
# Install dependencies (npm workspaces)
pnpm install

# Type check (TypeScript)
pnpm run typecheck

# Validate all skill metadata and schemas
pnpm run validate

# Run smoke tests (syntax check all skills)
pnpm test

# Run unit tests
pnpm run test:unit

# Regenerate skill index
pnpm run generate-index

# Build TypeScript
pnpm run build

# Run quality audit
node scripts/audit_skills.cjs

# Run benchmarks
pnpm run benchmark
```

### Creating a New Skill

Use the creation wizard or copy from templates:

```bash
# Recommended: use the wizard
pnpm run create-skill -- my-skill --description "My new skill"

# Templates available:
# - templates/skill-template-cjs/  (CommonJS, recommended)
# - templates/skill-template-ts/   (TypeScript)
```

### Shared Libraries

All skills use these shared libraries from `libs/core/` (aliased as `@agent/core`):

| Library             | Import                                              | Purpose                                            |
| ------------------- | --------------------------------------------------- | -------------------------------------------------- |
| `skill-wrapper.cjs` | `runSkill()` / `runSkillAsync()`                    | Standardized JSON output format                    |
| `ledger.cjs`        | (Internal)                                          | **[NEW]** Tamper-evident governance audit trail    |
| `secret-guard.cjs`  | `getSecret()`                                       | **[NEW]** Secure secret retrieval & auto-masking   |
| `path-resolver.cjs` | `resolve()` / `skillDir()`                          | **[NEW]** Logical path & namespace resolution      |
| `tier-guard.cjs`    | `validateInjection()` / `validateWritePermission()` | Knowledge Tier & Write Governance                  |
| `secure-io.cjs`     | `safeReadFile()` / `safeWriteFile()`                | Safe file I/O with `skill://` support              |
| `core.cjs`          | `logger` / `fileUtils` / `errorHandler` / `Cache`   | Logging, Caching, Utils                            |
| `validators.cjs`    | `requireArgs()` / `validateFilePath()`              | CLI argument and path validation                   |
| `validate.cjs`      | `validateInput()` / `validateOutput()`              | JSON Schema validation                             |
| `metrics.cjs`       | `metrics.record()` / `metrics.detectRegressions()`  | Skill execution metrics & health checks            |
| `orchestrator.cjs`  | `runPipeline()` / `runParallel()`                   | Sequential and parallel skill execution with retry |

### Skill I/O Contract

All skills should conform to the JSON Schema in `schemas/`:

- `schemas/skill-input.schema.json` - Input contract
- `schemas/skill-output.schema.json` - Output contract

Use `runSkill()` from `@agent/core` to automatically produce compliant output:

```javascript
const { runSkill } = require('@agent/core');
runSkill('my-skill', () => {
  return { result: 'data' };
});
```

## License

[MIT License](./LICENSE) - Copyright (c) 2026 famaoai.

_Note: Certain industry standards in `knowledge/` are subject to their respective creators' rights. See [knowledge/README.md](./knowledge/README.md) for details._

## Acknowledgements & External Licenses

This ecosystem includes knowledge harvested from open-source projects to enhance its capabilities.

- **Everything Claude Code**: Selected rules and agent definitions in `knowledge/external-wisdom/everything-claude/` are derived from [everything-claude-code](https://github.com/affaan-m/everything-claude-code) by Affaan, used under the [MIT License](./knowledge/external-wisdom/everything-claude/LICENSE).

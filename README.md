# Gemini Skills Monorepo

Your personal AI agent team — assembled around who you are and what you do.

**131 skills** (all implemented) + **26 conceptual frameworks** documented in `knowledge/frameworks/`.

## Philosophy: "Everyone Can Automate Their Own Work"

This is not a generic tool collection. It is a system where **you define your persona, and it assembles a personalized AI agent team for you**.

1. **Define your persona** — Run `node scripts/init_wizard.cjs` and select your role (Engineer, CEO, PM/Auditor). The system configures itself around who you are.
2. **Get your skill team** — `skill-bundle-packager` assembles the right set of skills into a mission-ready bundle. Pre-built [Mission Playbooks](#mission-playbooks) (`ceo-strategy`, `product-audit`, `saas-roi`) provide ready-to-use workflows for common missions.
3. **Start automating** — Speak naturally. [Intent-driven routing](#intent-driven-routing) maps your requests to skill chains. `mission-control` orchestrates execution.

**Your knowledge stays yours.** The [3-Tier Knowledge Hierarchy](#3-tier-knowledge-hierarchy) (Public / Confidential / Personal) ensures each person's knowledge base is isolated and secure. Your personal settings always take priority — your API keys, your company's proprietary standards, your individual preferences.

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
npm run plugin -- install <package>    # Install from npm
npm run plugin -- register ./my-skill  # Register a local skill
npm run plugin -- list                 # List installed plugins
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
3. Validate: `npm run doctor`

## Project Status

Each skill has a `status` field in its `SKILL.md` frontmatter:

| Status        | Count | Meaning                                      |
| ------------- | ----- | -------------------------------------------- |
| `implemented` | 131   | Has runnable scripts in `scripts/` directory |

26 additional conceptual frameworks have been moved to `knowledge/frameworks/`.

---

## Available Skills

### Implemented Skills (131)

These skills have working code and can be executed.

#### Data Processing & Transformation

- **`data-transformer`**: Convert between CSV, JSON, and YAML formats
- **`data-collector`**: Collect and aggregate data from multiple sources
- **`db-extractor`**: Extract data from databases
- **`encoding-detector`**: Detect file encoding
- **`format-detector`**: Detect file formats
- **`doc-to-text`**: Universal document extractor

#### Document Generation

- **`excel-artisan`**: Generate Excel workbooks
- **`pdf-composer`**: Compose PDF documents
- **`ppt-artisan`**: Generate PowerPoint presentations
- **`word-artisan`**: Generate Word documents
- **`html-reporter`**: Generate HTML reports
- **`template-renderer`**: Render templates with data
- **`diagram-renderer`**: Text-to-Image (Mermaid)

#### Code Analysis & Quality

- **`code-lang-detector`**: Detect programming languages
- **`codebase-mapper`**: Map directory structure
- **`dependency-grapher`**: Generate dependency graphs
- **`diff-visualizer`**: Visualize code diffs
- **`local-reviewer`**: Local code review
- **`quality-scorer`**: Score code quality
- **`completeness-scorer`**: Score document completeness
- **`project-health-check`**: Check project health metrics
- **`sequence-mapper`**: Map execution sequences
- **`log-analyst`**: Analyze log files
- **`bug-predictor`**: Predict bug hotspots from git churn and complexity

#### Schema & Validation

- **`schema-inspector`**: Inspect data schemas
- **`schema-validator`**: Validate against schemas
- **`nonfunctional-architect`**: NFR grade wizard (IPA standards)

#### Classification & Detection

- **`doc-type-classifier`**: Classify document types
- **`domain-classifier`**: Classify domains
- **`intent-classifier`**: Classify user intents
- **`lang-detector`**: Detect natural languages
- **`sensitivity-detector`**: Detect sensitive data

#### API & Integration

- **`api-doc-generator`**: Generate API documentation
- **`api-fetcher`**: Fetch data from APIs
- **`audio-transcriber`**: Whisper audio transcription
- **`connection-manager`**: Manage external API credentials
- **`context-injector`**: Inject context into prompts (with Knowledge Tier validation)
- **`browser-navigator`**: Automate browser actions with Playwright

#### Knowledge & Content

- **`glossary-resolver`**: Resolve glossary terms
- **`knowledge-fetcher`**: Fetch knowledge assets
- **`layout-architect`**: Design document layouts
- **`doc-sync-sentinel`**: Detect documentation drift from code changes

#### Infrastructure & Security

- **`terraform-arch-mapper`**: Visualize IaC
- **`security-scanner`**: Trivy-integrated vulnerability scan
- **`test-genie`**: Generate and run test code

#### Issue & Project Management

- **`issue-to-solution-bridge`**: Analyze GitHub issues and suggest solutions

#### Voice & Platform

- **`voice-command-listener`**: Listen for voice commands (macOS)
- **`voice-interface-maestro`**: Voice interface control (macOS)
- **`biometric-context-adapter`**: Biometric context integration

#### Quality & Optimization

- **`skill-quality-auditor`**: 12-point quality checklist auditor
- **`prompt-optimizer`**: Analyze and improve SKILL.md quality
- **`refactoring-engine`**: Detect code smells across 7 categories
- **`knowledge-harvester`**: Analyze directories for tech stack and patterns
- **`knowledge-auditor`**: Audit knowledge tiers and detect confidential marker violations

#### Release & Documentation

- **`release-note-crafter`**: Generate release notes from Git logs
- **`boilerplate-genie`**: Scaffold new projects with best practices
- **`requirements-wizard`**: Requirements review based on IPA standards

#### Operations & Compliance

- **`license-auditor`**: Audit dependencies for license compliance
- **`operational-runbook-generator`**: Generate operational runbooks
- **`dataset-curator`**: Clean and structure data for AI/RAG pipelines
- **`asset-token-economist`**: Estimate token usage and costs for LLM inputs
- **`log-to-requirement-bridge`**: Extract requirements from log analysis
- **`cloud-cost-estimator`**: Estimate cloud infrastructure costs

#### Engineering & DevOps

- **`pr-architect`**: Generate PR descriptions from git history
- **`onboarding-wizard`**: Generate project onboarding documentation
- **`cloud-waste-hunter`**: Detect cloud infrastructure cost waste
- **`dependency-lifeline`**: Audit dependency health, detect outdated/deprecated packages
- **`performance-monitor-analyst`**: Analyze performance metrics with percentile and grading
- **`environment-provisioner`**: Generate Terraform, Docker, and K8s configs from service definitions
- **`test-suite-architect`**: Analyze test frameworks, coverage, and generate testing strategies

#### Orchestration

- **`skill-bundle-packager`**: Create mission-specific skill bundles
- **`github-skills-manager`**: Monorepo dashboard
- **`mission-control`**: Central workflow orchestration with pipeline and ad-hoc modes

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
npm run cli -- list

# List only implemented skills
npm run cli -- list --status implemented

# Run a skill
npm run cli -- run doc-type-classifier -- --input myfile.md

# Show skill info
npm run cli -- info data-transformer
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
npm run create-skill -- my-new-skill --description "Does something cool"

# Create from TypeScript template
npm run create-skill -- my-ts-skill --template ts --description "TypeScript skill"
```

### Performance Benchmarks

Measure syntax-check load times for all implemented skills:

```bash
npm run benchmark
# Results saved to evidence/benchmarks/
```

### Plugin Manager

Install external skills or register local skill directories:

```bash
# Install npm plugin
npm run plugin -- install some-plugin-package

# Register local skill
npm run plugin -- register ./path/to/skill

# List installed plugins
npm run plugin -- list

# Remove plugin
npm run plugin -- uninstall plugin-name
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
npm install

# Type check (TypeScript)
npm run typecheck

# Validate all skill metadata and schemas
npm run validate

# Run smoke tests (syntax check all skills)
npm test

# Run unit tests
npm run test:unit

# Regenerate skill index
npm run generate-index

# Build TypeScript
npm run build

# Run quality audit
node scripts/audit_skills.cjs

# Run benchmarks
npm run benchmark
```

### Creating a New Skill

Use the creation wizard or copy from templates:

```bash
# Recommended: use the wizard
npm run create-skill -- my-skill --description "My new skill"

# Templates available:
# - templates/skill-template-cjs/  (CommonJS, recommended)
# - templates/skill-template-ts/   (TypeScript)
```

### Shared Libraries

All skills can use these shared libraries from `scripts/lib/` (aliased as `@agent/core`):

| Library             | Import                                              | Purpose                                            |
| ------------------- | --------------------------------------------------- | -------------------------------------------------- |
| `skill-wrapper.cjs` | `runSkill()` / `runSkillAsync()`                    | Standardized JSON output format                    |
| `classifier.cjs`    | `classify()` / `classifyFile()`                     | Keyword-based classification engine                |
| `tier-guard.cjs`    | `validateInjection()` / `validateWritePermission()` | Knowledge Tier & Write Governance                  |
| `core.cjs`          | `logger` / `fileUtils` / `errorHandler` / `Cache`   | Logging, Safe I/O, Caching                         |
| `validators.cjs`    | `requireArgs()` / `validateFilePath()`              | CLI argument and path validation                   |
| `validate.cjs`      | `validateInput()` / `validateOutput()`              | JSON Schema validation                             |
| `metrics.cjs`       | `metrics.record()` / `metrics.detectRegressions()`  | Skill execution metrics & health checks            |
| `secure-io.cjs`     | `safeReadFile()` / `safeWriteFile()`                | Safe file I/O with governance checks               |
| `logger.cjs`        | `createLogger()`                                    | Structured leveled logging                         |
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

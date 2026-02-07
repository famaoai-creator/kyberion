# Gemini Skills Monorepo (Final Form)

A comprehensive ecosystem of 70+ specialized AI skills for the Gemini CLI, designed to automate the entire software engineering lifecycle, business strategy, and self-evolutionary engineering.

## Table of Contents
- [Quick Start](#quick-start)
- [Available Skills](#available-skills)
- [Usage Scenarios](./SCENARIOS.md)
- [Knowledge Base](#knowledge-base)
- [Contributing](#contributing)

## Quick Start
1. Clone this repository.
2. Install the skills manager: `gemini skill install ./github-skills-manager`
3. Install all skills: `for d in */; do gemini skill install "./$d" --scope user --consent; done`

## Available Skills

### 🧠 Strategic Orchestration (The Brain)
- **`mission-control`**: The ecosystem orchestrator. Coordinates 70+ skills for high-level goals.
- **`strategic-roadmap-planner`**: Analyzes technical debt and trends to propose prioritized 3-month roadmaps.
- **`stakeholder-communicator`**: Translates technical decisions into clear business value for non-tech leaders.

### 🔄 Self-Evolution & Mastery
- **`skill-evolution-engine`**: Analyzes performance to self-patch SKILL.md and scripts.
- **`prompt-optimizer`**: Refines agent instructions and context handling.
- **`skill-quality-auditor`**: Self-audit for monorepo integrity and documentation.
- **`knowledge-refiner`**: Consolidates and structures the shared knowledge base.

### 🚀 Advanced Scaffolding & Engineering
- **`boilerplate-genie`**: Scaffolds "healthy" projects with full CI/CD and testing setup.
- **`environment-provisioner`**: Generates multi-cloud IaC (Terraform, K8s) from requirements.
- **`test-suite-architect`**: Generates comprehensive test code (Jest, Pytest, Cypress) from RD.
- **`refactoring-engine`**: Executes large-scale architectural migrations across the codebase.

### 🛡️ Security, Resilience & Legal
- **`red-team-adversary`**: Active security "war gaming" to exploit and verify vulnerabilities.
- **`crisis-manager`**: Rapid response and diagnostics during production incidents.
- **`disaster-recovery-planner`**: Generates DR runbooks and audits infrastructure resilience.
- **`security-scanner`**: Trivy-integrated vulnerability and secret scan.
- **`license-auditor`**: Audits dependencies for legal risks and generates NOTICE files.

### 📝 Requirements & Data Quality
- **`requirements-wizard`**: (IPA-Standard) RD guide and review checklist.
- **`nonfunctional-architect`**: (IPA-Standard) Interactive NFR grade wizard.
- **`dataset-curator`**: Prepares and audits PII-free, high-quality datasets for AI/RAG.
- **`telemetry-insight-engine`**: Correlates production usage with requirement enhancements.
- **`doc-to-text`**: Universal document extractor with OCR.

### 🎨 UX & Globalization
- **`ux-auditor`**: Performs visual UX and accessibility audits on interfaces.
- **`localization-maestro`**: Automates i18n and audits for cultural appropriateness.
- **`ai-ethics-auditor`**: Audits AI implementations for bias, fairness, and privacy.

### 📂 Core Analysis & Utilities
- **`codebase-mapper`**: Maps directory structure for AI context.
- **`dependency-grapher`**: Generates Mermaid/DOT dependency graphs.
- **`terraform-arch-mapper`**: Visualizes IaC as Mermaid diagrams.
- **`schema-inspector`**: Locates and displays SQL/Prisma schemas.
- **`browser-navigator`**: Playwright-based browser automation.
- **`cloud-cost-estimator`**: Estimates monthly cloud costs from IaC.

## Usage Scenarios
See **[SCENARIOS.md](./SCENARIOS.md)** for how to combine these skills for automated UI auditing, security pipelines, and strategic planning.

## Knowledge Base
Structured `knowledge/` directory:
- `nonfunctional/`: IPA Grade 2018 definitions.
- `testing/`: TIS Catalog v1.6.
- `requirements-guide/`: IPA RD best practices.
- `browser-scenarios/`: Reusable Playwright scripts.

## License
Custom - See individual skill directories for specific usage terms (e.g., IPA, TIS).

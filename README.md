# Gemini Skills Monorepo

A collection of 40+ specialized AI skills for the Gemini CLI, designed to automate software engineering, quality assurance, and documentation tasks.

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

### 📂 Analysis & Mapping
- **`codebase-mapper`**: Maps directory structure for AI context.
- **`dependency-grapher`**: Generates Mermaid/DOT dependency graphs.
- **`terraform-arch-mapper`**: Visualizes IaC as Mermaid diagrams.
- **`sequence-mapper`**: Generates sequence diagrams from function calls.
- **`code-lang-detector`**: Identifies source code languages.

### 📝 Requirements & Documentation
- **`requirements-wizard`**: (IPA-Standard) RD guide and review checklist.
- **`nonfunctional-architect`**: (IPA-Standard) Interactive NFR grade wizard.
- **`api-doc-generator`**: Generates API docs from OpenAPI/code.
- **`doc-to-text`**: Universal extractor (PDF, Excel, Word, OCR, ZIP).
- **`ppt-artisan`**: Markdown to PowerPoint (Marp-based).
- **`excel-artisan`**: JSON/HTML to Excel converter.
- **`word-artisan`**: Markdown to Word converter.
- **`pdf-composer`**: Markdown to PDF with custom headers.

### 🛡️ Quality & Security
- **`security-scanner`**: Trivy-integrated vulnerability and secret scan.
- **`project-health-check`**: Audits CI/CD, Tests, and Linting status.
- **`test-viewpoint-analyst`**: (IPA/TIS-Standard) Generates test scenarios.
- **`test-genie`**: Executes test suites and analyzes output.
- **`local-reviewer`**: Pre-commit AI code review.
- **`sensitivity-detector`**: Detects PII and sensitive data.
- **`quality-scorer`**: Evaluates text readability and quality.

### 🌐 Browser & Web
- **`browser-navigator`**: Playwright-based browser automation.
- **`api-fetcher`**: Secure REST/GraphQL data fetching.
- **`data-collector`**: Traceable web data harvesting with metadata.

### 🛠️ Utilities
- **`github-skills-manager`**: Monorepo skill management dashboard.
- **`diagram-renderer`**: Text-to-Image (Mermaid/PlantUML -> PNG).
- **`schema-inspector`**: Locates and displays SQL/Prisma schemas.
- **`db-extractor`**: Extracts schema/samples from live databases.
- **`log-analyst`**: Analyzes errors from log tails.
- **`audio-transcriber`**: Whisper-based audio transcription.
- **`data-transformer`**: CSV/JSON/YAML format converter.

## Usage Scenarios
For real-world examples (e.g., automated UI auditing, security pipelines), see **[SCENARIOS.md](./SCENARIOS.md)**.

## Knowledge Base
This monorepo includes a structured `knowledge/` directory shared across skills:
- `nonfunctional/`: IPA Non-Functional Grade 2018 definitions.
- `testing/`: TIS Test Viewpoint Catalog v1.6.
- `requirements-guide/`: IPA RD best practices.
- `security/`: Custom scan patterns.
- `browser-scenarios/`: Reusable Playwright scripts.

## License
Custom - See individual skill directories for specific usage terms (e.g., IPA, TIS).

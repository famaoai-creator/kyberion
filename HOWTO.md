# How-To Guide: Gemini Skills Ecosystem

Practical recipes for daily use. Each section is a self-contained task you can follow step by step.

---

## Table of Contents

1. [Initial Setup](#1-initial-setup)
2. [Run a Single Skill](#2-run-a-single-skill)
3. [Find the Right Skill](#3-find-the-right-skill)
4. [Run a Pipeline (Multi-Skill Chain)](#4-run-a-pipeline-multi-skill-chain)
5. [Use Mission Control (Orchestrator)](#5-use-mission-control-orchestrator)
6. [Create a Skill Bundle for Your Persona](#6-create-a-skill-bundle-for-your-persona)
7. [Set Up Your Knowledge Tiers](#7-set-up-your-knowledge-tiers)
8. [Create a New Skill](#8-create-a-new-skill)
9. [Install External Plugins](#9-install-external-plugins)
10. [Write a Custom Pipeline](#10-write-a-custom-pipeline)
11. [Audit Skill Quality](#11-audit-skill-quality)
12. [Run Tests & Benchmarks](#12-run-tests--benchmarks)

---

## 1. Initial Setup

```bash
git clone https://github.com/famaoai-creator/gemini-skills.git
cd gemini-skills

# Interactive wizard — selects your role, installs dependencies, generates skill index
node scripts/init_wizard.cjs
```

The wizard asks your role (**Engineer**, **CEO**, **PM/Auditor**) and configures the ecosystem accordingly.

**Verify everything is working:**

```bash
bash scripts/troubleshoot_doctor.sh
```

This checks: Node.js version, Git repository, Confidential Knowledge link, and NPM registry connectivity.

---

## 2. Run a Single Skill

Use the unified CLI to run any implemented skill:

```bash
# Basic syntax
npm run cli -- run <skill-name> -- [args...]

# Examples
npm run cli -- run codebase-mapper -- "." 3
npm run cli -- run security-scanner
npm run cli -- run data-transformer -- --input data.csv --format json
npm run cli -- run quality-scorer -- -i ./src/app.js
```

You can also run skill scripts directly:

```bash
node data-transformer/scripts/transform.cjs --input data.csv --format json
```

All skills produce a standardized JSON envelope:

```json
{
  "skill": "data-transformer",
  "status": "success",
  "data": { "...": "result here" },
  "metadata": {
    "duration_ms": 42,
    "timestamp": "2026-02-08T10:00:00.000Z"
  }
}
```

---

## 3. Find the Right Skill

**List all skills:**

```bash
npm run cli -- list
```

**List only implemented skills:**

```bash
npm run cli -- list implemented
```

**Show details about a specific skill:**

```bash
npm run cli -- info data-transformer
```

**Search by keyword in skill names:**

```bash
# The CLI shows "Did you mean:" suggestions for partial matches
npm run cli -- run security
# → Did you mean: security-scanner?
```

---

## 4. Run a Pipeline (Multi-Skill Chain)

Pipelines chain multiple skills together, passing data between steps.

**Run a pre-built pipeline:**

```bash
# Security audit pipeline
node mission-control/scripts/orchestrate.cjs --pipeline pipelines/security-audit.yml --dir .

# Code quality pipeline
node mission-control/scripts/orchestrate.cjs --pipeline pipelines/code-quality.yml --input ./src/app.js

# Release pipeline (health check → security → licenses → bugs → release notes)
node mission-control/scripts/orchestrate.cjs --pipeline pipelines/release-pipeline.yml --dir .
```

**Available pre-built pipelines** (in `pipelines/`):

| Pipeline                       | Description                                                      |
| ------------------------------ | ---------------------------------------------------------------- |
| `security-audit.yml`           | Codebase mapping + vulnerability scan + bug prediction           |
| `full-security-audit.yml`      | Extended security analysis                                       |
| `code-quality.yml`             | Quality scoring + completeness + format detection                |
| `code-health.yml`              | Project health metrics                                           |
| `release-pipeline.yml`         | Pre-release: health + security + licenses + bugs + release notes |
| `compliance-audit.yml`         | License and compliance checks                                    |
| `documentation-sync.yml`       | Documentation drift detection                                    |
| `documentation-excellence.yml` | Full documentation quality check                                 |
| `team-onboarding.yml`          | New member onboarding documentation                              |
| `knowledge-extraction.yml`     | Tech stack and pattern extraction                                |
| `cost-optimization-audit.yml`  | Cloud cost analysis                                              |
| `intelligent-code-review.yml`  | AI-powered code review                                           |
| `ecosystem-health-monitor.yml` | Full ecosystem health check                                      |
| `full-quality-gate.yml`        | Complete quality gate for releases                               |
| `data-flow-audit.yml`          | Data flow security audit                                         |
| `doc-analysis.yml`             | Document analysis pipeline                                       |

---

## 5. Use Mission Control (Orchestrator)

`mission-control` is the central entry point for running skill chains.

**Pipeline mode** — run a YAML pipeline:

```bash
node mission-control/scripts/orchestrate.cjs \
  --pipeline pipelines/security-audit.yml \
  --dir /path/to/project
```

**Ad-hoc mode** — run skills by name (sequential):

```bash
node mission-control/scripts/orchestrate.cjs \
  --skills "codebase-mapper,security-scanner,bug-predictor" \
  --dir /path/to/project
```

**Parallel mode** — run skills simultaneously:

```bash
node mission-control/scripts/orchestrate.cjs \
  --skills "quality-scorer,completeness-scorer,format-detector" \
  --input ./src/app.js \
  --parallel
```

**Options:**

| Flag         | Short | Description                      |
| ------------ | ----- | -------------------------------- |
| `--pipeline` | `-p`  | Path to YAML pipeline file       |
| `--skills`   | `-s`  | Comma-separated skill names      |
| `--dir`      | `-d`  | Working directory (default: `.`) |
| `--input`    | `-i`  | Input file path                  |
| `--output`   | `-o`  | Output file path                 |
| `--parallel` |       | Run ad-hoc skills in parallel    |

---

## 6. Create a Skill Bundle for Your Persona

Bundle specific skills into a mission-ready package.

**Create a bundle:**

```bash
# Syntax: bundle.cjs <mission-name> <skill-1> <skill-2> ...

# CEO strategy bundle
node skill-bundle-packager/scripts/bundle.cjs ceo-strategy \
  codebase-mapper quality-scorer security-scanner release-note-crafter

# Engineer daily toolkit
node skill-bundle-packager/scripts/bundle.cjs engineer-daily \
  local-reviewer security-scanner project-health-check log-analyst

# PM audit bundle
node skill-bundle-packager/scripts/bundle.cjs pm-audit \
  project-health-check quality-scorer completeness-scorer license-auditor
```

Bundles are saved to `work/bundles/<mission-name>/bundle.json`:

```json
{
  "mission": "engineer-daily",
  "created_at": "2026-02-08T10:00:00.000Z",
  "skills": [
    { "name": "local-reviewer", "path": "./local-reviewer/" },
    { "name": "security-scanner", "path": "./security-scanner/" },
    { "name": "project-health-check", "path": "./project-health-check/" },
    { "name": "log-analyst", "path": "./log-analyst/" }
  ]
}
```

**Use with Mission Playbooks:**

Refer to existing playbooks in `knowledge/orchestration/mission-playbooks/` for pre-defined role-specific bundles:

- `ceo-strategy.md` — Strategic decision-making (CEO)
- `product-audit.md` — Release quality audit (PM/Auditor)
- `saas-roi.md` — SaaS unit economics (CEO)

---

## 7. Set Up Your Knowledge Tiers

The 3-tier knowledge system lets each person maintain secure, personalized knowledge.

### Public Tier (`knowledge/`)

Shared with the team via Git. Already populated with frameworks, tech-stack guides, and security patterns.

```bash
# Browse available knowledge
ls knowledge/
# ai-engineering/ ceo/ devops/ fisc-compliance/ frameworks/ ...
```

### Confidential Tier (`knowledge/confidential/`)

Company/client secrets. Managed separately from the main repository.

```bash
# Set up as a symlink to your company's private knowledge repo
ln -s /path/to/company-knowledge knowledge/confidential

# Or create the directory structure manually
mkdir -p knowledge/confidential/skills/my-skill
mkdir -p knowledge/confidential/clients/client-a
```

**Structure:**

```
knowledge/confidential/
├── skills/
│   └── <skill-name>/     # Skill-specific proprietary rules
└── clients/
    └── <client-name>/    # Client-specific regulations
```

### Personal Tier (`knowledge/personal/`)

Your private space. Created by `init_wizard.cjs`. **Never committed to Git.**

```bash
# Store API keys
echo "OPENAI_API_KEY=sk-..." > knowledge/personal/.env

# Store personal preferences
cat > knowledge/personal/preferences.json << 'EOF'
{
  "default_output_format": "markdown",
  "language": "ja",
  "timezone": "Asia/Tokyo"
}
EOF
```

### How Precedence Works

When the same setting exists in multiple tiers:

```
Personal (wins)  >  Confidential (Client)  >  Confidential (General)  >  Public
```

The `tier-guard.cjs` library enforces this and prevents higher-tier data from leaking into lower-tier outputs:

```javascript
const { validateInjection, scanForConfidentialMarkers } = require('./scripts/lib/tier-guard.cjs');

// Validate before injecting knowledge into a skill
validateInjection(sourcePath, targetTier);

// Scan output for accidental secret inclusion
scanForConfidentialMarkers(outputText);
```

---

## 8. Create a New Skill

**Using the wizard (recommended):**

```bash
# CommonJS template (default)
npm run create-skill -- my-new-skill --description "Analyzes something useful"

# TypeScript template
npm run create-skill -- my-ts-skill --template ts --description "TypeScript skill"
```

This creates:

```
my-new-skill/
├── package.json
├── SKILL.md           # Metadata and documentation
└── scripts/
    └── main.cjs       # Implementation (uses runSkill wrapper)
```

**Implement your logic:**

```javascript
// my-new-skill/scripts/main.cjs
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');

runSkill('my-new-skill', () => {
  // Your logic here
  return { result: 'Hello from my skill!' };
});
```

**Available shared libraries:**

```javascript
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs'); // Standard output
const { classify } = require('../../scripts/lib/classifier.cjs'); // Classification
const { validateInjection } = require('../../scripts/lib/tier-guard.cjs'); // Knowledge tier
const { logger, fileUtils } = require('../../scripts/lib/core.cjs'); // Logging, file I/O
const { requireArgs } = require('../../scripts/lib/validators.cjs'); // Argument validation
const { validateInput } = require('../../scripts/lib/validate.cjs'); // Schema validation
const { safeReadFile } = require('../../scripts/lib/secure-io.cjs'); // Safe file I/O
const { createLogger } = require('../../scripts/lib/logger.cjs'); // Structured logging
const { MetricsCollector } = require('../../scripts/lib/metrics.cjs'); // Metrics
```

**Verify quality:**

```bash
node scripts/audit_skills.cjs
```

---

## 9. Install External Plugins

**Install from npm:**

```bash
npm run plugin -- install some-skill-package
```

**Register a local skill directory:**

```bash
npm run plugin -- register ./path/to/my-local-skill
```

**List installed plugins:**

```bash
npm run plugin -- list
```

**Remove a plugin:**

```bash
npm run plugin -- uninstall plugin-name
```

**How plugins work:**

Plugins use a hook system via `.gemini-plugins.json`. Every skill execution can be intercepted:

```json
{
  "plugins": ["./my-plugins/audit-logger.cjs"]
}
```

A plugin module can export:

```javascript
module.exports = {
  beforeSkill(skillName, args) {
    console.log(`Starting: ${skillName}`);
  },
  afterSkill(skillName, output) {
    console.log(`Finished: ${skillName}, status: ${output.status}`);
  },
};
```

---

## 10. Write a Custom Pipeline

Create a YAML file in `pipelines/`:

```yaml
# pipelines/my-custom-pipeline.yml
name: My Custom Pipeline
description: Analyze code and generate a report
steps:
  - skill: codebase-mapper
    args: '"{{dir}}" 3'
    output: map
  - skill: quality-scorer
    args: '-i "{{input}}"'
    output: quality
  - skill: html-reporter
    args: '--input "$prev.output"'
    output: report
```

**Variable substitution:**

| Variable     | Replaced with                 |
| ------------ | ----------------------------- |
| `{{dir}}`    | `--dir` value                 |
| `{{input}}`  | `--input` value               |
| `{{output}}` | `--output` value              |
| `$prev.*`    | Output from the previous step |

**Run your pipeline:**

```bash
node mission-control/scripts/orchestrate.cjs \
  --pipeline pipelines/my-custom-pipeline.yml \
  --dir /path/to/project \
  --input ./src/main.js
```

**Programmatic usage (in your own scripts):**

```javascript
const { runPipeline, runParallel, loadPipeline } = require('./scripts/lib/orchestrator.cjs');

// Sequential pipeline
const result = runPipeline([
  { skill: 'codebase-mapper', params: { dir: '.' } },
  { skill: 'security-scanner', params: { input: '$prev.output' } },
]);

// Parallel execution
const result = await runParallel([
  { skill: 'quality-scorer', params: { input: 'file.js' } },
  { skill: 'completeness-scorer', params: { input: 'file.js' } },
]);

// Load and run from YAML
const pipeline = loadPipeline('pipelines/security-audit.yml');
const result = pipeline.run({ dir: '/path/to/project' });
```

**Advanced step options:**

```yaml
steps:
  - skill: security-scanner
    args: '"{{dir}}"'
    retries: 2 # Retry up to 2 times on failure
    retryDelay: 3000 # Wait 3 seconds between retries
    timeout: 120000 # 2 minute timeout
    continueOnError: true # Don't stop pipeline on failure
```

---

## 11. Audit Skill Quality

Run the quality audit to check all implemented skills:

```bash
# Table format
node scripts/audit_skills.cjs

# JSON format (for CI integration)
node scripts/audit_skills.cjs --format json
```

**The audit checks 5 criteria per skill:**

| Check      | What it verifies                                          |
| ---------- | --------------------------------------------------------- |
| `pkg.json` | Has a `package.json`                                      |
| `wrapper`  | Uses `runSkill()` or `runSkillAsync()` from skill-wrapper |
| `yargs`    | Uses `yargs` for argument parsing                         |
| `SKILL.md` | Has valid metadata (name, description, status)            |
| `tests`    | Has unit tests in `tests/unit.test.cjs`                   |

Each skill gets a score from 0/5 to 5/5.

---

## 12. Run Tests & Benchmarks

```bash
# Smoke tests (syntax check all skills)
npm test

# Unit tests
npm run test:unit

# TypeScript type checking
npm run typecheck

# Validate all skill metadata and schemas
npm run validate

# Regenerate skill index
npm run generate-index

# Build TypeScript
npm run build

# Performance benchmarks (load time per skill)
npm run benchmark
# Results saved to evidence/benchmarks/
```

---

## Quick Reference

| Task           | Command                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| Setup          | `node scripts/init_wizard.cjs`                                           |
| Run a skill    | `npm run cli -- run <skill> -- [args]`                                   |
| List skills    | `npm run cli -- list [implemented\|planned]`                             |
| Skill info     | `npm run cli -- info <skill>`                                            |
| Run pipeline   | `node mission-control/scripts/orchestrate.cjs -p pipelines/<name>.yml`   |
| Ad-hoc chain   | `node mission-control/scripts/orchestrate.cjs -s "skill-a,skill-b" -d .` |
| Parallel run   | `node mission-control/scripts/orchestrate.cjs -s "a,b,c" --parallel`     |
| Create bundle  | `node skill-bundle-packager/scripts/bundle.cjs <mission> <skills...>`    |
| New skill      | `npm run create-skill -- <name> --description "..."`                     |
| Install plugin | `npm run plugin -- install <package>`                                    |
| Quality audit  | `node scripts/audit_skills.cjs`                                          |
| Run tests      | `npm run test:unit`                                                      |
| Benchmark      | `npm run benchmark`                                                      |

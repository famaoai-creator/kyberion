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
13. [Use the Presence Layer (Sensors)](#13-use-the-presence-layer-sensors)

---

## 1. Initial Setup

```bash
git clone https://github.com/famaoai-creator/kyberion.git
cd kyberion

# Interactive wizard — selects your role, installs dependencies, generates skill index
node dist/scripts/init_wizard.js
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
node data-transformer/scripts/transform.js --input data.csv --format json
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
node mission-control/scripts/orchestrate.js --pipeline pipelines/security-audit.yml --dir .

# Code quality pipeline
node mission-control/scripts/orchestrate.js --pipeline pipelines/code-quality.yml --input ./src/app.js

# Release pipeline (health check → security → licenses → bugs → release notes)
node mission-control/scripts/orchestrate.js --pipeline pipelines/release-pipeline.yml --dir .
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
node mission-control/scripts/orchestrate.js \
  --pipeline pipelines/security-audit.yml \
  --dir /path/to/project
```

**Ad-hoc mode** — run skills by name (sequential):

```bash
node mission-control/scripts/orchestrate.js \
  --skills "codebase-mapper,security-scanner,bug-predictor" \
  --dir /path/to/project
```

**Parallel mode** — run skills simultaneously:

```bash
node mission-control/scripts/orchestrate.js \
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
# Syntax: bundle.js <mission-name> <skill-1> <skill-2> ...

# CEO strategy bundle
node skill-bundle-packager/scripts/bundle.js ceo-strategy \
  codebase-mapper quality-scorer security-scanner release-note-crafter

# Engineer daily toolkit
node skill-bundle-packager/scripts/bundle.js engineer-daily \
  local-reviewer security-scanner project-health-check log-analyst

# PM audit bundle
node skill-bundle-packager/scripts/bundle.js pm-audit \
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

Your private space. Created by `init_wizard.js`. **Never committed to Git.**

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

The `tier-guard.js` library enforces this and prevents higher-tier data from leaking into lower-tier outputs:

```javascript
const { validateInjection, scanForConfidentialMarkers } = require('./scripts/lib/tier-guard.js');

// Validate before injecting knowledge into a skill
validateInjection(sourcePath, targetTier);

// Scan output for accidental secret inclusion
scanForConfidentialMarkers(outputText);
```

---

## 8. Create a New Skill (The Skill Genesis Lifecycle)

In the Gemini Skills Ecosystem, **you do not write skill code first**. Skills must be distilled from real-world success (Wisdom). Follow the **Skill Genesis Lifecycle**:

### Step 1: Idea (Intent Definition)
Do not write code yet. First, create a `SKILL.md` in the appropriate category directory to define the intent, inputs, and expected output.

### Step 2: Mission Execution (Ad-hoc Prototyping)
When a real task arrives, follow the **③ Alignment Phase** protocol defined in `knowledge/governance/phases/alignment.md`. Use **KSMC v2.0** (`scripts/mission_controller.ts start`) to initiate the mission. All operations, even in experimentation, MUST use `@agent/core/secure-io`. **Direct use of `node:fs` is strictly prohibited.**

### Step 3: Validation
Verify that your ad-hoc solution perfectly solves the mission.

### Step 4: Distillation (Spinal Cord Compilation)
Once proven, extract the robust logic into a formal skill.

**Using the wizard:**

```bash
# Always use the TypeScript template for new skills
pnpm run create-skill -- my-new-skill --template ts --description "Proven logic from mission X"
```

This creates a modernized, testable structure:

```
my-new-skill/
├── package.json
├── tsconfig.json
├── SKILL.md
└── src/
    ├── index.ts       # CLI Entry point (uses runSkill)
    ├── lib.ts         # Pure logic (testable)
    └── lib.test.ts    # Vitest suite
```

**Implement your logic in TypeScript:**

```typescript
// src/lib.ts
import { KnowledgeProvider } from '@agent/core/knowledge-provider';
import { safeReadFile } from '@agent/core/secure-io';

export function doWork(input: string) {
  // Pure logic goes here, independent of CLI arguments
  return { result: `Processed: ${input}` };
}
```

```typescript
// src/index.ts
import { runSkill } from '@agent/core/skill-wrapper';
import { doWork } from './lib';
import yargs from 'yargs';

runSkill('my-new-skill', () => {
  const argv = yargs(process.argv.slice(2)).options({
    input: { type: 'string', demandOption: true }
  }).parseSync();
  
  return doWork(argv.input);
});
```

**Available shared libraries (TypeScript ready):**

```typescript
import { runSkill } from '@agent/core/skill-wrapper'; // Standard output
import { classify } from '@agent/core/classifier'; // Classification
import { KnowledgeProvider } from '@agent/core/knowledge-provider'; // Knowledge tier access
import { logger, fileUtils } from '@agent/core/core'; // Logging, file I/O
import { requireArgs } from '@agent/core/validators'; // Argument validation
import { validateInput } from '@agent/core/validate'; // Schema validation
import { safeReadFile } from '@agent/core/secure-io'; // Safe file I/O
import { createLogger } from '@agent/core/logger'; // Structured logging
import { MetricsCollector } from '@agent/core/metrics'; // Metrics
```

**Verify quality:**

```bash
node audit_skills.js
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
  "plugins": ["./my-plugins/audit-logger.js"]
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
node mission-control/scripts/orchestrate.js \
  --pipeline pipelines/my-custom-pipeline.yml \
  --dir /path/to/project \
  --input ./src/main.js
```

**Programmatic usage (in your own scripts):**

```javascript
const { runPipeline, runParallel, loadPipeline } = require('./scripts/lib/orchestrator.js');

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
node audit_skills.js

# JSON format (for CI integration)
node audit_skills.js --format json
```

**The audit checks 5 criteria per skill:**

| Check      | What it verifies                                          |
| ---------- | --------------------------------------------------------- |
| `pkg.json` | Has a `package.json`                                      |
| `wrapper`  | Uses `runSkill()` or `runSkillAsync()` from skill-wrapper |
| `yargs`    | Uses `yargs` for argument parsing                         |
| `SKILL.md` | Has valid metadata (name, description, status)            |
| `tests`    | Has unit tests in `tests/unit.test.js`                   |

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
| Setup          | `node dist/scripts/init_wizard.js`                                           |
| Run a skill    | `npm run cli -- run <skill> -- [args]`                                   |
| List skills    | `npm run cli -- list [implemented\|planned]`                             |
| Skill info     | `npm run cli -- info <skill>`                                            |
| Run pipeline   | `node mission-control/scripts/orchestrate.js -p pipelines/<name>.yml`   |
| Ad-hoc chain   | `node mission-control/scripts/orchestrate.js -s "skill-a,skill-b" -d .` |
| Parallel run   | `node mission-control/scripts/orchestrate.js -s "a,b,c" --parallel`     |
| Create bundle  | `node skill-bundle-packager/scripts/bundle.js <mission> <skills...>`    |
| New skill      | `npm run create-skill -- <name> --description "..."`                     |
| Install plugin | `npm run plugin -- install <package>`                                    |
| Quality audit  | `node audit_skills.js`                                          |
| Run tests      | `npm run test:unit`                                                      |
| Benchmark      | `npm run benchmark`                                                      |

---

## 13. Use the Presence Layer (Sensors)

The Presence Layer allows the ecosystem to sense the environment and react to asynchronous stimuli.

### 📡 Seeing Pending Stimuli

The CLI automatically displays a dashboard of pending sensory inputs on startup:

```bash
node dist/scripts/cli.js
# ⏳ SENSORY INTERVENTION: 2 signals 
#   ▪ [slack] What is the status of the current mission?
#   ▪ [voice] Run security scan now.
```

### 💬 Interacting via Slack

If you have configured the `slack-connector`, you can send messages to the agent from your mobile or desktop.

1.  **Incoming**: A message from Slack is written to `presence/bridge/stimuli.jsonl`.
2.  **Recognition**: During your next terminal interaction, the agent will "Whisper" this message to itself and prioritize a response.
3.  **Mode**: If in **BATCH** mode, the agent will complete its current task before reporting the result back to Slack.

### 🎙️ Interacting via Voice

1.  **Launch the Hub**: `node presence/sensors/voice-hub/scripts/launch.js` (requires Python).
2.  **Command**: Speak naturally. Commands like "Check system health" are detected and injected as **REALTIME** stimuli.
3.  **Priority**: Voice commands always override Slack or background Pulse events.

### 🩺 Monitoring via Pulse

`gemini-pulse` runs in the background, monitoring for critical file system events (e.g., a security violation or a broken link).

-   **Dashboard**: View the real-time health in **Chronos Mirror** (`http://localhost:3030`).
-   **Intervention**: Critical failures are injected as high-priority stimuli for immediate attention.

### 👁️ Visual Capture (Screenshot)

The Agent can capture the physical state of your workspace to assist with UI/UX debugging or document analysis.

1.  **Manual Trigger**: `node dist/scripts/cli.js system visual-capture`
2.  **Output**: Images are saved to `active/shared/captures/`.
3.  **Requirements (macOS)**: Ensure your terminal (iTerm2, Code) has **Screen Recording** permissions in System Settings.

### 🛡️ Managing Background Services (Watchdog)

Background sensors and daemons are managed via a central service manager.

1.  **Start all services**: `node dist/scripts/cli.js system services start`
2.  **Check status**: `node dist/scripts/cli.js system services status`
3.  **Watchdog**: Once started, a `service-watchdog` process automatically monitors and restarts crashed services every 30 seconds.


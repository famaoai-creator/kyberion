# Quick Start: Your Personal AI Agent Team

Gemini Skills is built on one idea: **you define who you are, and the system assembles the right AI team for you**. In three steps, you go from persona definition to automated workflows — with your knowledge kept secure in your own tier.

## The Concept

```
Define Your Persona          Get Your Skill Team              Start Automating
─────────────────────  →  ───────────────────────────  →  ─────────────────────────
"I am a CEO"               ceo-strategy playbook            "Draft a strategic roadmap"
                            + 4 recommended skills           → intent routing → results
```

The init wizard asks who you are. Based on your answer, it configures the ecosystem — setting up your personal knowledge directory, recommending the right skill bundles and playbooks, and getting you ready to automate your work.

---

## Step 1: Setup

```bash
# Clone the repository
git clone https://github.com/famaoai-creator/gemini-skills.git
cd gemini-skills

# The wizard installs dependencies, selects your role, and configures everything
node scripts/init_wizard.cjs
```

The wizard will ask you to choose your role:

- **Engineer** — Code analysis, testing, DevOps, refactoring
- **CEO / Executive** — Strategy, finance, organizational decisions
- **PM / Auditor** — Compliance, quality assurance, project governance

## Step 2: Verify Your Environment

```bash
npm run doctor
```

## Step 3: Set Up Your Knowledge

The wizard created `knowledge/personal/` for you — a Git-ignored directory for your private configuration.

| Tier             | Where to Place            | Example                                       |
| ---------------- | ------------------------- | --------------------------------------------- |
| **Personal**     | `knowledge/personal/`     | API keys, personal preferences, private notes |
| **Confidential** | `knowledge/confidential/` | Company standards, client-specific rules      |
| **Public**       | `knowledge/`              | Shared frameworks, tech-stack guides          |

Your personal settings always take priority. See [3-Tier Knowledge Hierarchy](./README.md#3-tier-knowledge-hierarchy) for details.

## Step 4: Your First Mission

### For CEOs / Executives

> "Execute the ceo-strategy playbook for evaluating our new market entry."

Uses: `mission-control` → `scenario-multiverse-orchestrator`, `financial-modeling-maestro`, `competitive-intel-strategist`

Playbook: [`knowledge/orchestration/mission-playbooks/ceo-strategy.md`](./knowledge/orchestration/mission-playbooks/ceo-strategy.md)

### For Engineers

> "Analyze this repository and create a refactoring plan."

Uses: `codebase-mapper` → `refactoring-engine` (or the **Legacy Modernization** intent chain)

### For PM / Auditors

> "Run a full product audit and generate the compliance report."

Uses: `product-audit` playbook → `project-health-check`, `security-scanner`, `ux-auditor`

Playbook: [`knowledge/orchestration/mission-playbooks/product-audit.md`](./knowledge/orchestration/mission-playbooks/product-audit.md)

---

## Next Steps

- Browse available playbooks: [`knowledge/orchestration/mission-playbooks/`](./knowledge/orchestration/mission-playbooks/)
- Create a custom skill bundle:
  ```bash
  node skill-bundle-packager/scripts/bundle.cjs my-mission skill-a skill-b skill-c
  ```
- Install an external plugin:
  ```bash
  npm run plugin -- install <package>
  ```
- See full documentation: [`README.md`](./README.md)

---

**Need Help?**
See `README.md` for the full list of 131 skills, or ask Gemini: "Help me find the right skill for [your task]."

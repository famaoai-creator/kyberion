# Quick Start: Your Personal AI Agent Team

Gemini Skills is built on one idea: **you define who you are, and the system assembles the right AI team for you**. In three steps, you go from persona definition to automated workflows — with your knowledge kept secure in your own tier.

## The Concept

```
Define Your Persona    →    Phase 0: Alignment (Brain)    →    Phase 1: Execution (Spinal Cord)
─────────────────────       ──────────────────────────         ───────────────────────────────
"I am a CEO"                Task Board & Strategy              Run Playbooks / Skills
                            + 3-Tier Wisdom                    → intent routing → results
```

The init wizard asks who you are. Based on your answer, it configures the ecosystem — setting up your personal knowledge directory, recommending the right skill bundles and playbooks, and getting you ready to automate your work safely.

---

## Step 1: Setup

```bash
# Clone the repository
git clone https://github.com/famaoai-creator/kyberion.git
cd kyberion

# Install dependencies
pnpm install

# The interactive wizard configures your identity and environment
pnpm onboard
```

The wizard will help you establish your:
- **Name** — How the ecosystem should address you.
- **Language** — Preferred communication language.
- **Interaction Style** — Senior Partner, Concierge, or Minimalist.
- **Primary Domain** — Software Engineering, CEO, PM, etc.

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

Every mission begins in **Phase 0: Alignment**. You must discuss your intent with the agent and establish a `TASK_BOARD.md` before executing skills.

### For CEOs / Executives

> "I want to evaluate our new market entry using the ceo-strategy playbook. Let's do the Alignment phase first."

*Agent will create a Task Board using:* `scenario-multiverse-orchestrator`, `financial-modeling-maestro`, `competitive-intel-strategist`

### For Engineers

> "I need to modernize this legacy component. Let's align on a strategy and create a Task Board."

*Agent will create a Task Board using:* `codebase-mapper` → `refactoring-engine`

### For PM / Auditors

> "Run a full product audit. Draft the plan in a Task Board first."

*Agent will create a Task Board using:* `project-health-check`, `security-scanner`, `ux-auditor`

---

## Next Steps

- Browse available playbooks: [`knowledge/orchestration/mission-playbooks/`](./knowledge/orchestration/mission-playbooks/)
- Create a custom skill bundle:
  ```bash
  npm run cli -- run skill-bundle-packager -- my-mission skill-a skill-b
  ```
- Install an external plugin:
  ```bash
  npm run plugin -- install <package>
  ```
- Read the Governance Rules: [`AGENTS.md`](./AGENTS.md)

---

**Need Help?**
See `README.md` for the full list of 131 skills, or ask Gemini: "Help me find the right skill for [your task]."

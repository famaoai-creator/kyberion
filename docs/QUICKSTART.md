# Quick Start: Mission-First Kyberion

Kyberion is built on one idea: **keep the mission model simple and let the control plane handle the orchestration**.

You define intent, Kyberion creates or resumes a mission, and the runtime supervisor plus orchestration worker coordinate the rest.

## The Concept

```
Define Your Persona    →    Phase 0: Alignment (Brain)    →    Phase 1: Execution (Spinal Cord)
─────────────────────       ──────────────────────────         ───────────────────────────────
"I am a CEO"                Task Board & Strategy              Run Playbooks / Skills
                            + 3-Tier Wisdom                    → intent routing → results
```

The init wizard asks who you are. Based on your answer, it configures the ecosystem — setting up your personal knowledge directory, recommending the right skill bundles and playbooks, and getting you ready to automate your work safely.

---

## Step 1: Setup and Build

```bash
# Clone the repository
git clone https://github.com/famaoai-creator/kyberion.git
cd kyberion

# Install dependencies
pnpm install

# Build package-local artifacts and repo dist
pnpm build

# Start background surfaces from the canonical manifest
pnpm surfaces:reconcile

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
pnpm run doctor
pnpm capabilities
```

`pnpm run doctor` で基本的な健全性を、`pnpm capabilities` で現在の OS / バイナリ環境に対してどのアクチュエータ機能が利用可能かを確認できます。

If you want the local control plane running:

```bash
pnpm agent-runtime:supervisor
pnpm mission:orchestrator
```

## Step 3: Discover What You Can Run

Before starting a mission, use the CLI to discover available actuators from the global actuator index.

```bash
# Show all indexed actuators
pnpm run cli -- list

# Search by keyword
pnpm run cli -- search browser

# Inspect one actuator in more detail
pnpm run cli -- info browser-actuator
```

## Step 3.5: Keep Package Imports Clean

When you write or change runtime code, import shared kernel modules through `@agent/core` public entrypoints only.

Examples:

```ts
import { safeReadFile } from "@agent/core/secure-io";
import { rootResolve } from "@agent/core/path-resolver";
```

Do not import from:

- `@agent/core/src/*`
- `@agent/core/dist/*`
- `../libs/core/*`

Reference:
- [`docs/PACKAGING_CONTRACT.md`](./PACKAGING_CONTRACT.md)

## Step 4: Set Up Your Knowledge

The wizard created `knowledge/personal/` for you — a Git-ignored directory for your private configuration.

| Tier             | Where to Place            | Example                                       |
| ---------------- | ------------------------- | --------------------------------------------- |
| **Personal**     | `knowledge/personal/`     | API keys, personal preferences, private notes |
| **Confidential** | `knowledge/confidential/` | Company standards, client-specific rules      |
| **Public**       | `knowledge/`              | Shared frameworks, tech-stack guides          |

Your personal settings always take priority. See [README: Governance](../README.md#governance) for details.

## Step 5: Your First Mission

Every mission begins in **Phase 0: Alignment**. You must discuss your intent with the agent and establish a `TASK_BOARD.md` before executing actuators and mission flows.

If you want an operator UI while doing this, start Chronos:

```bash
export KYBERION_LOCALHOST_AUTOADMIN=true
pnpm chronos:dev
```

Chronos is the local control surface for:

- mission state
- runtime leases
- surface outbox and delivery
- control action queue
- live agent conversation and A2A handoffs

### For CEOs / Executives

> "I want to evaluate our new market entry using the ceo-strategy playbook. Let's do the Alignment phase first."

*Agent will create a Task Board using the appropriate actuator chain and governance flow.*

### For Engineers

> "I need to modernize this legacy component. Let's align on a strategy and create a Task Board."

*Agent will create a Task Board using the appropriate actuator chain and governance flow.*

### For PM / Auditors

> "Run a full product audit. Draft the plan in a Task Board first."

*Agent will create a Task Board using the appropriate actuator chain and governance flow.*

---

## Next Steps

- Read the top-level overview: [`README.md`](../README.md)
- Browse available playbooks: [`knowledge/orchestration/mission-playbooks/`](./knowledge/orchestration/mission-playbooks/)
- Install an external plugin:
  ```bash
  npm run plugin -- install <package>
  ```
- Read the Governance Rules: [`AGENTS.md`](../AGENTS.md)
- Understand key terms: [`docs/GLOSSARY.md`](./GLOSSARY.md)
- Explore the architecture: [`docs/COMPONENT_MAP.md`](./COMPONENT_MAP.md)
- Browse the full actuator catalog: [`CAPABILITIES_GUIDE.md`](../CAPABILITIES_GUIDE.md)

---

**Need Help?**
See [`CAPABILITIES_GUIDE.md`](../CAPABILITIES_GUIDE.md) for the full list of capabilities, or ask Kyberion: "Help me find the right actuator for [your task]."

# Kyberion

<p align="center">
  <img src="./docs/assets/kyberion-wordmark.svg" alt="Kyberion" width="920" />
</p>

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg" /></a>
  <a href="https://nodejs.org/"><img alt="Node.js >=24" src="https://img.shields.io/badge/Node.js-%3E%3D24.0.0-339933.svg?logo=node.js" /></a>
  <a href="https://github.com/famaoai-creator/kyberion/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/famaoai-creator/kyberion/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Status" src="https://img.shields.io/badge/Status-OSS%20%7C%20active%20development-0f172a" />
</p>

<p align="center">
  <img alt="Category" src="https://img.shields.io/badge/category-agent%20orchestration-0ea5e9" />
  <img alt="Category" src="https://img.shields.io/badge/category-browser%20automation-14b8a6" />
  <img alt="Category" src="https://img.shields.io/badge/category-voice%20workflow-f59e0b" />
  <img alt="Category" src="https://img.shields.io/badge/category-audit%20trails-6366f1" />
  <img alt="Category" src="https://img.shields.io/badge/category-self%20hosted-475569" />
</p>

<p align="center"><strong>An organization work loop engine.</strong><br />You phrase outcomes. Kyberion plans, runs, and remembers with evidence.</p>

<p align="center">Intent → Plan → Result</p>

Kyberion turns intent into governed execution. You ask `今週の進捗レポートを作って` or `この PDF をパワポにして`, and it picks the right actuators, runs the work, asks only when something is genuinely ambiguous, and returns the result plus an artifact plus a trace that next runs can learn from.

**For people new to the repo**

- If you want to try it quickly, start with [`docs/QUICKSTART.md`](./docs/QUICKSTART.md).
- If you want to understand what it does, read [`docs/WHY.md`](./docs/WHY.md) and [`docs/SCENARIO_CATALOG.md`](./docs/SCENARIO_CATALOG.md).
- If you want to extend it, jump to [`docs/developer/EXTENSION_POINTS.md`](./docs/developer/EXTENSION_POINTS.md) and [`CAPABILITIES_GUIDE.md`](./CAPABILITIES_GUIDE.md).

**Why this matters**: knowledge work is moving from "I do this manually with LLM help" to "I delegate and verify". The winning system is not the most chat-fluent model, but the engine that captures intent reliably, keeps evidence, and accumulates organizational memory. See [`docs/WHY.md`](./docs/WHY.md) for the full thesis ([日本語版](./docs/WHY.ja.md)).

---

## Quick Start

> **Canonical cold-start source: [`docs/INITIALIZATION.md`](./docs/INITIALIZATION.md).** The commands below are a summary; if anything conflicts, INITIALIZATION.md wins.

Kyberion's first visible result comes in three short paths:

- 30 seconds: run `pnpm doctor` and see Kyberion's readiness boundary
- 5 minutes: run the clean browser smoke and get `active/shared/tmp/first-win-session.png`
- 15 minutes: read the Quickstart structure map, then inspect the pipeline and actuator entrypoints

If you want the shortest startup path first, run this:

```bash
pnpm install
pnpm prereq:check
pnpm build
pnpm setup:report --persona first-time-user
```

If a browser, voice, or media actuator is missing a local dependency, inspect it directly with the on-demand pull resolver:

```bash
pnpm deps:check --actuator browser
pnpm deps:check --actuator voice
pnpm deps:check --actuator media-generation
```

Requires Node.js 24+ (`.nvmrc` / `package.json` engines) and pnpm.

```bash
git clone https://github.com/famaoai-creator/kyberion.git
cd kyberion
pnpm install
pnpm prereq:check                       # verifies Node 24+ floor; warns if Playwright browsers are missing
pnpm exec playwright install chromium   # recommended: the browser smoke needs it
pnpm build
pnpm onboard
pnpm doctor
pnpm setup:report --persona first-time-user
```

If you already have onboarding JSON, use Path B instead of the wizard:

```bash
pnpm onboard:apply --identity knowledge/public/templates/onboarding/identity.example.json --dry-run
```

Copy that template, edit it for your identity, then rerun without `--dry-run` to write the onboarding artifacts.

Then pick a smoke path:

```bash
# Clean browser smoke: opens a local first-win page and writes active/shared/tmp/first-win-session.png
pnpm pipeline --input pipelines/verify-session.json

# Voice smoke: browser speech in, OS-native speech out
pnpm pipeline --input pipelines/voice-hello.json
```

To understand the structure in 15 minutes, read [`docs/QUICKSTART.md`](./docs/QUICKSTART.md) sections 4-10, then inspect [`pipelines/verify-session.json`](./pipelines/verify-session.json), [`CAPABILITIES_GUIDE.md`](./CAPABILITIES_GUIDE.md), and [`docs/developer/EXTENSION_POINTS.md`](./docs/developer/EXTENSION_POINTS.md).

If you do not know which surface to use next, `pnpm setup:report --persona first-time-user` now acts as the entry guide. It tells you whether to start with Chronos, the voice path, or a messaging surface, and whether auth/setup is still blocking that route.

Chronos API routes still accept `KYBERION_API_TOKEN` or `KYBERION_LOCALADMIN_TOKEN` for local access. Replacing that token gate with a proper IdP-backed user session is a follow-up item, so treat the current token requirement as a known limitation.

For a concise map of entry points and their intended use, read [`docs/SURFACES.md`](./docs/SURFACES.md).
For the full canonical setup, see [`docs/INITIALIZATION.md`](./docs/INITIALIZATION.md) (structure map: [`docs/QUICKSTART.md`](./docs/QUICKSTART.md)). For deployment to a server / customer environment, see [`docs/operator/DEPLOYMENT.md`](./docs/operator/DEPLOYMENT.md).

---

## What It Covers

Kyberion currently covers:

- **Browser automation**: record a web flow once, replay it reliably.
- **Voice workflows**: browser speech, OS-native speech, and self-hosted options.
- **File and media handling**: PDF, PPTX, XLSX, DOCX, image, and video work.
- **Code assistance**: refactor, scaffold, and analyze codebases.
- **Network and service actions**: governed fetch plus Slack / Google / Notion / Microsoft 365 integration.
- **System operations**: shell, screenshots, and OS-level introspection.
- **Knowledge and memory**: search, distill, and reuse organizational hints.

Plus:

- **ADF pipeline format** — declarative, schema-validated, sub-pipeline composable. With `on_error` recovery semantics.
- **Mission lifecycle** — each piece of work is a mission with its own git repo, state, evidence. Survives 24h+ runs.
- **Three-tier knowledge isolation** — `personal/` / `confidential/` / `public/` enforced at the file-IO boundary.
- **Customer aggregation** — `customer/{slug}/` overlay for FDE / implementation-support engagements without forks.
- **Trace + audit** — OTel-inspired structured tracing per run, append-only audit chain.

For the catalog of actuators: [`CAPABILITIES_GUIDE.md`](./CAPABILITIES_GUIDE.md). For the architecture: [`knowledge/product/architecture/organization-work-loop.md`](./knowledge/product/architecture/organization-work-loop.md).

---

## Project Status

**OSS, in active development.** Pre-1.0. The roadmap is in [`docs/PRODUCTIZATION_ROADMAP.md`](./docs/PRODUCTIZATION_ROADMAP.md):

- **Phase A** — Make first-win 5 minutes. (in progress)
- **Phase B** — Make it survive 30 days of continuous use. (foundations landed)
- **Phase C'** — Make it contributable in under a week.
- **Phase D'** — Make FDE / implementation-support engagements possible without forks.

The strategic positioning is **OSS-first, with paid implementation support / FDE** as the eventual revenue model. SaaS only after a clear user base exists. See `docs/PRODUCTIZATION_ROADMAP.md` §0 for the explicit "yes / no" list.

---

## Documentation Map

| If you want to                     | Read                                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Understand why this exists         | [`docs/WHY.md`](./docs/WHY.md) / [`.ja.md`](./docs/WHY.ja.md)                                                                                  |
| Try it in 5 minutes                | [`docs/QUICKSTART.md`](./docs/QUICKSTART.md)                                                                                                   |
| Deploy it for a customer           | [`docs/operator/DEPLOYMENT.md`](./docs/operator/DEPLOYMENT.md)                                                                                 |
| Browse what it can automate        | [`docs/SCENARIO_CATALOG.md`](./docs/SCENARIO_CATALOG.md)                                                                                       |
| Understand the architecture        | [`knowledge/product/architecture/organization-work-loop.md`](./knowledge/product/architecture/organization-work-loop.md)                       |
| Author a new actuator / pipeline   | [`docs/developer/EXTENSION_POINTS.md`](./docs/developer/EXTENSION_POINTS.md)                                                                   |
| Customize for a customer           | [`docs/developer/CUSTOMER_AGGREGATION.md`](./docs/developer/CUSTOMER_AGGREGATION.md) / [`.ja.md`](./docs/developer/CUSTOMER_AGGREGATION.ja.md) |
| Contribute                         | [`CONTRIBUTING.md`](./CONTRIBUTING.md)                                                                                                         |
| Understand the data flow / privacy | [`docs/PRIVACY.md`](./docs/PRIVACY.md) / [`.ja.md`](./docs/PRIVACY.ja.md)                                                                      |
| Report a security issue            | [`SECURITY.md`](./SECURITY.md)                                                                                                                 |

Three audiences, three folders:

- [`docs/user/`](./docs/user/) — using Kyberion to get work done.
- [`docs/operator/`](./docs/operator/) — running Kyberion as a service.
- [`docs/developer/`](./docs/developer/) — extending Kyberion.

---

## How It Compares

| You've used                       | What Kyberion adds                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **ChatGPT / Claude.ai**           | Stateful missions, governed execution, a catalog of actuators (browser, file, voice, …), audit chain, reusable memory across runs. |
| **Cursor**                        | Code is one actuator among many. The unit of work is a long-running mission with persistent state, not a single chat.              |
| **Computer Use / browser agents** | Mission-scoped state, tier-isolated knowledge, customer aggregation. The browser is one tool, not the substrate.                   |
| **Zapier / n8n / RPA**            | Replaces brittle rule chains with intent-driven plans. Plans survive site changes via Trace-fed reusable hints.                    |
| **AI Ops / agent SaaS**           | OSS, self-hostable, customer-data-stays-local. No central server. FDE-ready for implementation engagements.                        |

---

## License

MIT — see [`LICENSE`](./LICENSE).

Third-party dependencies and their licenses are inventoried by `pnpm license:audit` (output at [`docs/legal/third-party-licenses.json`](./docs/legal/third-party-licenses.json)).

## Code of Conduct

We follow the [Contributor Covenant](https://www.contributor-covenant.org/) — see [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## Governance

Decision-making process: [`GOVERNANCE.md`](./GOVERNANCE.md). Maintainers: [`MAINTAINERS.md`](./MAINTAINERS.md). Code owners: [`CODEOWNERS`](./CODEOWNERS).

## Contributing

PRs welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Security disclosure: [`SECURITY.md`](./SECURITY.md). Roadmap context: [`docs/PRODUCTIZATION_ROADMAP.md`](./docs/PRODUCTIZATION_ROADMAP.md).

---

> Kyberion is operator-facing in English, conceptually-authored in Japanese. Both languages are first-class. See [`docs/DOCUMENTATION_LOCALIZATION_POLICY.md`](./docs/DOCUMENTATION_LOCALIZATION_POLICY.md).

# Kyberion

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-339933.svg?logo=node.js)](https://nodejs.org/)
[![CI](https://github.com/famaoai-creator/kyberion/actions/workflows/ci.yml/badge.svg)](https://github.com/famaoai-creator/kyberion/actions/workflows/ci.yml)

> **An organization work loop engine.**
> You phrase outcomes. Kyberion plans, runs, and remembers — with audit trails.

```
Intent → Plan → Result
```

You ask `今週の進捗レポートを作って` or `この PDF をパワポにして` — Kyberion picks the right actuators, runs the work, asks only when something is genuinely ambiguous, and gives you a result + an artifact + a trace that next runs can learn from.

**Why this matters**: knowledge work is moving from "I do this manually with LLM help" to "I delegate and verify". The winning system is not the most chat-fluent model — it's the engine that captures intent reliably, has evidence and audit, and accumulates organizational memory. See [`docs/WHY.md`](./docs/WHY.md) for the full thesis ([日本語版](./docs/WHY.ja.md)).

---

## First win smoke

Kyberion's first visible result comes in three short paths:

- 30 seconds: run `pnpm doctor` and see Kyberion's readiness/value boundary
- 5 minutes: run the clean browser smoke and get `active/shared/tmp/first-win-session.png`
- 15 minutes: read the Quickstart structure map, then inspect the pipeline and actuator entrypoints

```bash
git clone https://github.com/famaoai-creator/kyberion.git
cd kyberion
pnpm install
pnpm build
pnpm onboard
pnpm doctor
```

Then pick a smoke path:

```bash
# Clean browser smoke: opens a local first-win page and writes active/shared/tmp/first-win-session.png
pnpm pipeline --input pipelines/verify-session.json

# Voice smoke: browser speech in, OS-native speech out
pnpm pipeline --input pipelines/voice-hello.json
```

To understand the structure in 15 minutes, read [`docs/QUICKSTART.md`](./docs/QUICKSTART.md) sections 4-10, then inspect [`pipelines/verify-session.json`](./pipelines/verify-session.json), [`CAPABILITIES_GUIDE.md`](./CAPABILITIES_GUIDE.md), and [`docs/developer/EXTENSION_POINTS.md`](./docs/developer/EXTENSION_POINTS.md).

For the full setup, see [`docs/QUICKSTART.md`](./docs/QUICKSTART.md). For deployment to a server / customer environment, see [`docs/operator/DEPLOYMENT.md`](./docs/operator/DEPLOYMENT.md).

---

## What's in the box

23+ actuators covering:

- **Browser** (Playwright-driven): record any web flow once, replay forever. RPA without the brittleness.
- **Voice** (3 tiers, OS-native default → cloud → local self-hosted).
- **File / Media**: PDF, PPTX, XLSX, DOCX, image, video — read, transform, generate.
- **Code**: refactor, scaffold, analyze.
- **Network**: governed fetch, A2A transport.
- **Service**: unified Slack / Google / Notion / Microsoft 365 connection layer.
- **System**: shell, screenshots, OS-level introspection.
- **Wisdom**: knowledge tier search, distillation, reusable hint generation.

Plus:

- **ADF pipeline format** — declarative, schema-validated, sub-pipeline composable. With `on_error` recovery semantics.
- **Mission lifecycle** — each piece of work is a mission with its own git repo, state, evidence. Survives 24h+ runs.
- **Three-tier knowledge isolation** — `personal/` / `confidential/` / `public/` enforced at the file-IO boundary.
- **Customer aggregation** — `customer/{slug}/` overlay for FDE / implementation-support engagements without forks.
- **Trace + audit** — OTel-inspired structured tracing per run, append-only audit chain.

For the catalog of actuators: [`CAPABILITIES_GUIDE.md`](./CAPABILITIES_GUIDE.md). For the architecture: [`knowledge/public/architecture/organization-work-loop.md`](./knowledge/public/architecture/organization-work-loop.md).

---

## Status

**OSS, in active development.** Pre-1.0. The roadmap is in [`docs/PRODUCTIZATION_ROADMAP.md`](./docs/PRODUCTIZATION_ROADMAP.md):

- **Phase A** — Make first-win 5 minutes. (in progress)
- **Phase B** — Make it survive 30 days of continuous use. (foundations landed)
- **Phase C'** — Make it contributable in under a week.
- **Phase D'** — Make FDE / implementation-support engagements possible without forks.

The strategic positioning is **OSS-first, with paid implementation support / FDE** as the eventual revenue model. SaaS only after a clear user base exists. See `docs/PRODUCTIZATION_ROADMAP.md` §0 for the explicit "yes / no" list.

---

## Documentation map

| If you want to | Read |
|---|---|
| Understand why this exists | [`docs/WHY.md`](./docs/WHY.md) / [`.ja.md`](./docs/WHY.ja.md) |
| Try it in 5 minutes | [`docs/QUICKSTART.md`](./docs/QUICKSTART.md) |
| Deploy it for a customer | [`docs/operator/DEPLOYMENT.md`](./docs/operator/DEPLOYMENT.md) |
| Browse what it can automate | [`docs/SCENARIO_CATALOG.md`](./docs/SCENARIO_CATALOG.md) |
| Understand the architecture | [`knowledge/public/architecture/organization-work-loop.md`](./knowledge/public/architecture/organization-work-loop.md) |
| Author a new actuator / pipeline | [`docs/developer/EXTENSION_POINTS.md`](./docs/developer/EXTENSION_POINTS.md) |
| Customize for a customer | [`docs/developer/CUSTOMER_AGGREGATION.md`](./docs/developer/CUSTOMER_AGGREGATION.md) / [`.ja.md`](./docs/developer/CUSTOMER_AGGREGATION.ja.md) |
| Contribute | [`CONTRIBUTING.md`](./CONTRIBUTING.md) |
| Understand the data flow / privacy | [`docs/PRIVACY.md`](./docs/PRIVACY.md) / [`.ja.md`](./docs/PRIVACY.ja.md) |
| Report a security issue | [`SECURITY.md`](./SECURITY.md) |

Three audiences, three folders:

- [`docs/user/`](./docs/user/) — using Kyberion to get work done.
- [`docs/operator/`](./docs/operator/) — running Kyberion as a service.
- [`docs/developer/`](./docs/developer/) — extending Kyberion.

---

## How it compares

| You've used | What Kyberion adds |
|---|---|
| **ChatGPT / Claude.ai** | Stateful missions, governed execution, a catalog of actuators (browser, file, voice, …), audit chain, reusable memory across runs. |
| **Cursor** | Code is one actuator among many. The unit of work is a long-running mission with persistent state, not a single chat. |
| **Computer Use / browser agents** | Mission-scoped state, tier-isolated knowledge, customer aggregation. The browser is one tool, not the substrate. |
| **Zapier / n8n / RPA** | Replaces brittle rule chains with intent-driven plans. Plans survive site changes via Trace-fed reusable hints. |
| **AI Ops / agent SaaS** | OSS, self-hostable, customer-data-stays-local. No central server. FDE-ready for implementation engagements. |

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

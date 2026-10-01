# Core Concepts — the 5 you need first

You can run Kyberion's first win without learning its whole vocabulary. These five ideas are enough to read the CLI output, the surfaces, and most of the docs. Each links to the [GLOSSARY](./GLOSSARY.md) for the precise definition; everything else in the glossary is **advanced** and can wait until you operate or extend the system.

The loop they all serve: **Intent → Plan → Result** (see [QUICKSTART](./QUICKSTART.md)).

## 1. Mission

A bounded unit of work with a lifecycle (`planned → active → finished`), its own git history, state, and evidence. Missions are started, checkpointed, and finished only through the mission controller (`pnpm mission …`), so work is resumable and auditable. Lighter, conversational work is a **Task Session**; a mission is for work that needs evidence and rollback.

- Glossary: [Mission](./GLOSSARY.md#mission) · [Task Session](./GLOSSARY.md#task-session) · [Artifact](./GLOSSARY.md#artifact)
- Try: `pnpm mission hygiene` (lists stalled missions)

## 2. Pipeline

A declarative, schema-validated description of steps (ADF — Agentic Data Format) that Kyberion runs under governance: trace, budgets, guardrails, replay. Repeatable work is captured as a pipeline instead of being re-improvised. Ready-made system pipelines live in [`pipelines/`](../pipelines/README.md); user-facing patterns are templates under `knowledge/product/pipeline-templates/`.

- Glossary: [Pipeline](./GLOSSARY.md#contributor-vocabulary) · [ADF](./GLOSSARY.md#adf-agentic-data-format)
- Try: `pnpm pipeline --input pipelines/verify-session.json`

## 3. Actuator

A governed capability module that actually does things — browser, files, voice, media, code, services. Pipelines and missions never touch the outside world directly; they call actuator operations (`domain:action`, e.g. `media:pptx_render`), which enforce secure I/O and policy. The catalog is in [CAPABILITIES_GUIDE](../CAPABILITIES_GUIDE.md).

- Glossary: [Actuator](./GLOSSARY.md#actuator)
- Try: `pnpm capabilities`

## 4. Tenant and tier

Knowledge and data are split by **tier** — `personal/` → `confidential/` → `public/` — and by **tenant**, an isolation boundary identified by a slug (`knowledge/confidential/{tenant-slug}/`). Data never flows from a higher tier to a lower one, and cross-tenant access is denied unless brokered and audited. If you only work for yourself, you can stay in `personal/` and ignore tenants until later.

- Glossary: [Tenant](./GLOSSARY.md#tenant) · [Tier Isolation](./GLOSSARY.md#tier-isolation) · [Stance (vs tenant customer)](./GLOSSARY.md#stance-vs-tenant-customer) _(advanced)_

## 5. Surface

A human-facing entrance, each with one role: **Concierge** (what do I decide?), **Presence Studio** (what are we doing together?), **Chronos Mirror** (control tower), the audit monitor, the hands-on mirror, the terminal home (`pnpm kyberion`), chat bridges, and the local capture **pads** (`pnpm pads`). Surfaces show state and take requests; they do not own missions.

- Glossary: [Surfaces and channels](./GLOSSARY.md#surfaces-and-channels) (Surface, Display, Presence, Satellite, Bridge/Gateway/Channel, Pad, Concierge, Front Desk)
- Map: [SURFACES](./SURFACES.md) · Start with `pnpm kyberion`

---

**Next:** [QUICKSTART](./QUICKSTART.md) for the five-minute first win, then [COMPONENT_MAP](./COMPONENT_MAP.md) for the repository layout. To check your setup at any time: `pnpm kyberion doctor`.

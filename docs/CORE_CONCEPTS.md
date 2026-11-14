# Core Concepts — the 5 you need first

You can run Kyberion's first win without learning its whole vocabulary. These five ideas are the canonical first read: enough to read the CLI output, the surfaces, and most of the docs. Each links to the [GLOSSARY](./GLOSSARY.md) for the precise definition; everything else in the glossary is **advanced** and can wait until you operate or extend the system.

The loop they all serve: **Intent → Plan → Result** (see [QUICKSTART](./QUICKSTART.md)).

Kyberion lets a person or company delegate work, use permitted information and
services, and receive verifiable outcomes and learning. Solo and organization
use share one engine: a solo experience can hide unnecessary choices, but must
not remove ownership or authorization boundaries. The requester, accountable
human, executing identity, information owner, connection owner, and approver
may coincide for one person; they are not the same concept.

## 1. Mission

A bounded unit of work with a lifecycle (`planned → active → validating → distilling → completed`, plus `paused` / `failed` / `archived`), its own git history, state, and evidence. Missions are started, checkpointed, and finished only through the mission controller (`pnpm mission …`), so work is resumable and auditable (`pnpm mission finish` moves it to `completed`). Lighter, conversational work is a **Task Session**; a mission is for work that needs evidence and rollback. How Mission, Task, Task Contract, Task Session and WorkItem relate: [Units of work](./GLOSSARY.md#units-of-work).

- Glossary: [Mission](./GLOSSARY.md#mission) · [Task Session](./GLOSSARY.md#task-session) · [Artifact](./GLOSSARY.md#artifact)
- Try: `pnpm mission hygiene` (lists stalled missions)

Scope and execution answer different questions: a project can group both missions and task sessions, while a standalone mission needs no project and personal work needs no tenant. The scope chain lists applicable references in containment order; it does not require every request to create every level. See [scope references and execution choice](../knowledge/product/architecture/entity-scope-hierarchy.md#scope-references-and-execution-choice).

## 2. Pipeline

A declarative, schema-validated description of steps (ADF — Agentic Data Format) that Kyberion runs under governance: trace, budgets, guardrails, replay. Repeatable work is captured as a pipeline instead of being re-improvised. Ready-made system pipelines live in [`pipelines/`](../pipelines/README.md); user-facing patterns are templates under `knowledge/product/pipeline-templates/`.

- Glossary: [Pipeline](./GLOSSARY.md#contributor-vocabulary) · [ADF](./GLOSSARY.md#adf-agentic-data-format) · [Execution definitions](./GLOSSARY.md#execution-definitions) (pipeline vs template vs fragment)
- Try: `pnpm pipeline --input pipelines/verify-session.json`

## 3. Actuator

A governed capability module that actually does things — browser, files, voice, media, code, services. Pipelines and missions never touch the outside world directly; they call actuator operations (`domain:action`, e.g. `media:pptx_render`), which enforce secure I/O and policy. The catalog is in [CAPABILITIES_GUIDE](../CAPABILITIES_GUIDE.md).

- Glossary: [Actuator](./GLOSSARY.md#actuator)
- Try: `pnpm capabilities`

## 4. Tenant and tier

Knowledge and data are split by **tier** — `personal/` → `confidential/` → `public/` — and by **tenant**, an isolation boundary identified by a slug (`knowledge/confidential/{tenant-slug}/`). Data never flows from a higher tier to a lower one, and cross-tenant access is denied unless brokered and audited. If you only work for yourself, you can stay in `personal/` and ignore tenants until later.

- Glossary: [Tenant](./GLOSSARY.md#tenant) · [Tier Isolation](./GLOSSARY.md#tier-isolation) · [Stance (vs tenant customer)](./GLOSSARY.md#stance) _(advanced)_

For external API access, registering a personal key does not allocate it to a tenant.
An explicit allocation permits use; trusted dispatch binds the allowed credential
to the current task. Model selection and connectivity proofs are separate decisions.
See [Credential lifecycle, allocation, and execution](../knowledge/product/architecture/api-credential-proof-boundary.md)
for the conceptual contract and implemented versus planned capabilities.

### Who acts within a tenant?

A conversational persona such as Haru is the human-facing window, not the durable
identity that receives authority. Use a personal NHI for personal work and a
separate tenant-affiliated NHI for each company. Organization participation
describes membership and responsibilities; expertise profiles describe skills;
implementer and reviewer are task roles. None grants authority or replaces human
approval. Independent review requires a genuinely separate reviewer, not an alias
or session change. The common window never permits cross-tenant sharing or a
public downgrade. See the [actor identity and responsibility model](../knowledge/product/architecture/actor-identity-and-responsibility-model.md)
for the additive implementation and remaining migration work.

Changing whom the work is for does not transfer information, credentials, or
authority. A **Tenant** is the contract and isolation boundary (Company is its
alias); an **Organization** is a responsibility structure inside that tenant.
A **Stance** selects whom to act for, not permission to act. No additional
Workspace authority layer is needed. See the accepted
[Concept Model v2 decision](../knowledge/product/architecture/decisions/2026-11-10-concept-model-v2.md).

For external connections, ownership, permission to use an operation, credential
allocation, and approval of its effect are separate checks. Unknown personal
ownership is not permission for every logged-in member, even on localhost.
The [service integration guide](../knowledge/product/orchestration/service-integration-guide.md#solo-and-organization-rollout)
describes the implemented boundary, deliberate legacy migration, selected GWS
session provenance, internal encrypted account storage, and acting-for display.
Local account introduction and automatic broker provisioning remain unconnected;
storing material or changing the displayed context grants no execution authority.

## 5. Surface

A human-facing entrance, each with one role: **Concierge** (what do I decide?), **Presence Studio** (what are we doing together?), **Chronos Mirror** (control tower), the audit monitor, the hands-on mirror, the terminal home (`pnpm kyberion`), chat bridges, and the local capture **pads** (`pnpm pads`). Surfaces show state and take requests; they do not own missions.

- Glossary: [Surfaces and channels](./GLOSSARY.md#surfaces-and-channels) (Surface, Display, Presence, Satellite, Bridge/Gateway/Channel, Pad, Concierge, Front Desk)
- Map: [SURFACES](./SURFACES.md) · Start with `pnpm kyberion`

---

**Reading order:** [QUICKSTART](./QUICKSTART.md) (first win) → this page → [AGENTS.md](../AGENTS.md) (binding rules) → [GLOSSARY](./GLOSSARY.md) (precise definitions). [COMPONENT_MAP](./COMPONENT_MAP.md) is the repository layout when you need it. To check your setup at any time: `pnpm kyberion doctor`.

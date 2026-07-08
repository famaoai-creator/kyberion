# Kyberion Operating Guide

Binding rules and lifecycle for AI agents working in this repository. **Read this first, every session.**
Concepts are intentionally not explained here — follow the `→` links when you need the _why_.

> **Canonical file**: `AGENTS.md`. `CLAUDE.md`, `CODEX.md`, `GEMINI.md` are symlinks — edit here only.
> **Language**: rules in English; phase & onboarding docs in Japanese ([policy](./docs/DOCUMENTATION_LOCALIZATION_POLICY.md)).
> **First-time setup**: [docs/INITIALIZATION.md](./docs/INITIALIZATION.md).

## 1. Invariants — never violate

- **File I/O**: only via `@agent/core/secure-io`. Never call `node:fs` directly.
- **Missions**: start / checkpoint / finish only via `scripts/mission_controller.ts`. One owner per mission; workers act through task contracts and never mutate mission-wide state directly.
- **Data tiers**: `knowledge/personal/` → `confidential/` → `public/`. Never leak from a higher tier to a lower one. Project scope = `confidential/{project}/`.
- **ADF**: execute only validated contracts (`draft → preflight → auto-repair → commit → execute`). If invalid, dispatch a repair subagent (`validateAndRepairAdf`) first. On failure, classify and repair — never retry a broken contract.
- **Temp files**: `active/shared/tmp/` or mission-local storage only — never ad hoc directories.

→ Concepts: [GLOSSARY](./docs/GLOSSARY.md) (KSMC, ADF, mission, tier) · [mission-control-model](./knowledge/product/architecture/agent-mission-control-model.md) (why per-mission Git, atomic rollback)

## 2. Defaults — do unless there is a clear reason not to

- **Reuse, most-deterministic-first.** Prefer, in order: an existing `pipelines/` pipeline → existing actuators / governed compilers → hand-written ADF → ad-hoc Write/Edit. Check [`pipelines/README.md`](./pipelines/README.md) and [`CAPABILITIES_GUIDE.md`](./CAPABILITIES_GUIDE.md) before improvising; step down a rung only when the one above doesn't fit.
- **Promote repeated deterministic work into a pipeline.** When the same deterministic steps will run again (re-execution likely, or the pattern recurs), capture them as a `pipelines/` pipeline instead of re-improvising — so the next run is replayable and traceable. Keep steps that need fresh model judgment as semantic briefs, not frozen ADF.
- **Delegate heavy or specialized work** (bulk refactor, deep analysis, repair) to subagents via `getReasoningBackend().delegateTask()` to keep the main loop's context small.
- **Treat sandbox-sensitive tools as approval-first.** For any tool or CLI that depends on network access, GitHub API calls, external auth, IPC, GUI automation, or permission escalation, assume sandbox friction first and request approval before retrying. This applies beyond `gh` and `tsx`.
- **Mission-gate substantive work.** If a request meets **≥2 of**: (1) 5+ artifacts; (2) external/regulatory audience; (3) re-execution or variants likely; (4) same pattern expected ≥5×; (5) multiple legitimate viewpoints — create a mission + `pipelines/` pipeline instead of going straight to Write/Edit. Customer-facing governance evidence is **always** mission/pipeline (dog-food rule).
- **Reasoning backend**: prefer `KYBERION_REASONING_BACKEND=claude-cli` (local `claude` CLI, no API key) → `anthropic` (`ANTHROPIC_API_KEY`) → `stub` (offline/deterministic tests). Divergent-thinking `wisdom:*` ops need a non-stub backend.
- **Apply the working philosophy.** Read before write; one change, one verification; never retry unchanged without a new hypothesis; "done" requires evidence. Full rules: [working-philosophy](./knowledge/product/governance/working-philosophy.md) (auto-injected into worker prompts via `libs/core/working-principles.ts`).

→ Concepts: [GLOSSARY](./docs/GLOSSARY.md) · [PRODUCTIZATION_ROADMAP](./docs/PRODUCTIZATION_ROADMAP.md) (dog-food rationale)

## 3. Lifecycle — intent → goal → result

The work loop is: **capture intent → agree on the goal before changing anything (③) → execute (④) → review and learn (⑤).**

**On session start**, run `pnpm pipeline --input pipelines/baseline-check.json` and branch on the report's `status`:

| status             | action                                                                              |
| ------------------ | ----------------------------------------------------------------------------------- |
| `needs_recovery`   | → ② Recovery                                                                        |
| `needs_onboarding` | → ① Onboarding                                                                      |
| `needs_attention`  | → ③ Alignment, but surface the failed layer to the user first                       |
| `all_clear`        | → ③ Alignment                                                                       |
| `fatal_error`      | Pipeline itself failed — report to the user and halt; enter no phase until resolved |

1. **Onboarding** — set up environment & identity: `pnpm install → build → surfaces:reconcile → onboard`. → [onboarding.md](./knowledge/product/governance/phases/onboarding.md)
2. **Recovery** — restore prior state, resume from the suspension point. → [recovery.md](./knowledge/product/governance/phases/recovery.md)
3. **Alignment** — interpret intent and agree on goals. No code changes until goals are agreed. → [alignment.md](./knowledge/product/governance/phases/alignment.md)
4. **Execution** — change one thing, test immediately; on a major obstacle, return to ③. → [execution.md](./knowledge/product/governance/phases/execution.md)
5. **Review** — distill learnings (success & failure) into `knowledge/`, clean up temp files, auto-generate Trace-based hints for future runs. → [review.md](./knowledge/product/governance/phases/review.md)

→ Concepts: [INTENT_LOOP_CONCEPT](./docs/INTENT_LOOP_CONCEPT.md) · [USER_EXPERIENCE_CONTRACT](./docs/USER_EXPERIENCE_CONTRACT.md) · [WHY](./docs/WHY.md)

## 4. References

| Document                                                                                                       | Content                      |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| [docs/INITIALIZATION.md](./docs/INITIALIZATION.md)                                                             | First-time setup walkthrough |
| [docs/GLOSSARY.md](./docs/GLOSSARY.md)                                                                         | Key terms                    |
| [docs/COMPONENT_MAP.md](./docs/COMPONENT_MAP.md)                                                               | Directory structure          |
| [docs/QUICKSTART.md](./docs/QUICKSTART.md)                                                                     | Quick start                  |
| [CAPABILITIES_GUIDE.md](./CAPABILITIES_GUIDE.md)                                                               | Actuator catalog             |
| [docs/OPERATOR_UX_GUIDE.md](./docs/OPERATOR_UX_GUIDE.md)                                                       | Daily operations             |
| [pipelines/README.md](./pipelines/README.md)                                                                   | Pipeline catalog             |
| [phases/](./knowledge/product/governance/phases/)                                                              | Per-phase runbooks           |
| [architecture/agent-mission-control-model.md](./knowledge/product/architecture/agent-mission-control-model.md) | Mission control model        |

# Kyberion Documentation Index

**New here? Start with [QUICKSTART](./QUICKSTART.md).** It is the one front door; everything else in `docs/` is either a deeper reference you reach from it or a document with a narrower audience. The authority map for overlapping documents is [`documentation-source-map.json`](./documentation-source-map.json).

## By audience

| Audience                         | Entry                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| Using Kyberion to get work done  | [user/README.md](./user/README.md), then the [Commands Guide](./user/COMMANDS_GUIDE.md) |
| Deploying / running it           | [operator/README.md](./operator/README.md), [OPERATOR_UX_GUIDE](./OPERATOR_UX_GUIDE.md) |
| Extending / contributing         | [developer/README.md](./developer/README.md), [Kyberion in 1 hour](./developer/TOUR.md) |
| Looking up a command             | [CLI_REFERENCE](./CLI_REFERENCE.md) (generated from the command manifest)               |
| Looking up a term or a directory | [GLOSSARY](./GLOSSARY.md), [COMPONENT_MAP](./COMPONENT_MAP.md)                          |

## Setup and onboarding

| Document                                                                       | Role                                                                                                                               |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| [QUICKSTART](./QUICKSTART.md)                                                  | **Canonical.** First-win sequence, the [onboarding entry points table](./QUICKSTART.md#onboarding-entry-points), where to go next. |
| [INITIALIZATION](./INITIALIZATION.md) ([ja](./INITIALIZATION.ja.md))           | Day-2 command reference reached from QUICKSTART: readiness, surfaces, services, reasoning, identity, baseline.                     |
| [Onboarding standard flow](../knowledge/product/governance/onboarding-flow.md) | Canonical order of steps and route split (personal / AI company / existing tenant).                                                |
| [user/TROUBLESHOOTING](./user/TROUBLESHOOTING.md)                              | Common failures and fixes.                                                                                                         |

## Scenario and use-case documents

Seven documents describe what Kyberion can do. They overlap by design but have different jobs. **Canonical: [USE_CASES](./USE_CASES.md)** (breadth); the navigation entry point is [SCENARIO_CATALOG](./SCENARIO_CATALOG.md).

| Document                                                              | Role                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [SCENARIO_CATALOG](./SCENARIO_CATALOG.md)                             | Navigation entry for scenario docs; also lists executable scenarios (`pnpm scenario`).                 |
| [USE_CASES](./USE_CASES.md)                                           | **Canonical** automation catalog (Japanese). Add new scenarios here first.                             |
| [SCENARIOS](./SCENARIOS.md)                                           | Persona-mapped view layered on USE_CASES. Audience slice, not a second catalog.                        |
| [CEO_SCENARIOS](./CEO_SCENARIOS.md)                                   | Executive / decision-support slice with a pass/fail matrix.                                            |
| [user/USE_CASE_QUICKSTARTS](./user/USE_CASE_QUICKSTARTS.md)           | Three outcome-first starter paths (meeting, report, browser research).                                 |
| [TASK_SCENARIO_QUICKSTART](./TASK_SCENARIO_QUICKSTART.md)             | Hands-on first run of a repeatable task (`task:list`, `task:init`, `task:run --dry-run`).              |
| [INTENT_TO_USE_CASE_SCENARIO.ja](./INTENT_TO_USE_CASE_SCENARIO.ja.md) | Design note: how a free-text intent is connected to a use-case scenario and governance. Not a catalog. |

## Roadmaps and plans

**Canonical status of current work: [improvement-plans-2026-08/README.ja.md](./developer/improvement-plans-2026-08/README.ja.md)** (monthly indexes organise current and historical plans). The other documents are listed here so you know what each one is and is not.

| Document                                                    | Role                                                                          | Status                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------- |
| [ROADMAP](./ROADMAP.md)                                     | Cross-cutting index of roadmap documents.                                     | Supporting index                    |
| [PRODUCTIZATION_ROADMAP](./PRODUCTIZATION_ROADMAP.md)       | Master strategy: OSS hardening, managed SaaS, FDE readiness.                  | Current strategy (not a status log) |
| [TASK_SCENARIO_ROADMAP](./TASK_SCENARIO_ROADMAP.md)         | Feature roadmap for the outcome-first TaskScenario layer on top of USE_CASES. | Feature plan                        |
| [ROADMAP_COMPLETION_LEDGER](./ROADMAP_COMPLETION_LEDGER.md) | Index of items already completed across roadmaps.                             | Supporting index                    |
| [ROADMAP_ENGINE_REFINEMENT](./ROADMAP_ENGINE_REFINEMENT.md) | Older engine-refinement plan (pipeline composability and similar pillars).    | Superseded, kept for history        |

## Other top-level documents

| Document                                                                                                        | Role                                                                                    |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [HOWTO](./HOWTO.md)                                                                                             | Operating procedures for the intent gateway, missions and pipelines (after QUICKSTART). |
| [DOC_INVENTORY](./DOC_INVENTORY.md)                                                                             | Historical audit snapshot of `docs/` (2026-05); this index is the current map.          |
| [DOCUMENTATION_LOCALIZATION_POLICY](./DOCUMENTATION_LOCALIZATION_POLICY.md)                                     | English is canonical; `.ja.md` files are derived operator aids.                         |
| [WHY](./WHY.md), [CORE_CONCEPTS](./CORE_CONCEPTS.md), [USER_EXPERIENCE_CONTRACT](./USER_EXPERIENCE_CONTRACT.md) | Positioning, the five concepts to learn first, and the user-facing vocabulary contract. |

## Maintaining this index

A document that is superseded gets a banner pointing at its canonical replacement; its content is not deleted. When you add a scenario, add it to USE_CASES first. `pnpm generate:cli-reference` regenerates the command reference, and the `docs-drift` gate in `pnpm check` rejects references to commands, pipelines and directories that do not exist.

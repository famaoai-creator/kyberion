---
title: Scenario Catalog
category: User
tags: [scenarios, use-cases, catalog, automation]
importance: 7
last_updated: 2026-06-21
---

# Scenario Catalog

This is the canonical entry point for scenario documentation.

Kyberion currently has three scenario views:

| Doc                                                    | Role                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| [USE_CASES.md](./USE_CASES.md)                         | Canonical automation catalog. Use this first.                           |
| [SCENARIOS.md](./SCENARIOS.md)                         | Persona-mapped operational view.                                        |
| [CEO_SCENARIOS.md](./CEO_SCENARIOS.md)                 | Executive / decision-support view.                                      |
| [TASK_SCENARIO_ROADMAP.md](./TASK_SCENARIO_ROADMAP.md) | Outcome-first repeatable task catalog layered on top of `USE_CASES.md`. |

Rules:

- Treat `USE_CASES.md` as the source of truth for breadth.
- Keep `SCENARIOS.md` and `CEO_SCENARIOS.md` focused on their audience-specific slices.
- Use `TASK_SCENARIO_ROADMAP.md` for repeatable task setup flows; it extends, but does not replace, `USE_CASES.md`.
- If a new scenario is added, update the canonical catalog first, then mirror it into the other views only when the audience needs the split.

See also:

- [`docs/user/README.md`](./user/README.md)
- [`docs/DOC_INVENTORY.md`](./DOC_INVENTORY.md)
- [`docs/TASK_SCENARIO_ROADMAP.md`](./TASK_SCENARIO_ROADMAP.md)

# Marketing And Video Production

| Scenario                              | Risk | Canonical pipeline template                   | Completion boundary                                                                     |
| ------------------------------------- | ---: | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| Local YouTube video package           |    0 | `video-production.json`                       | Local review package exists; no publication                                             |
| Independent publication review        |  2-4 | `publication-review.json`                     | Required roles reviewed the same artifact hashes with no blocking finding               |
| Approved unlisted publication preview |    2 | `publish-youtube-dry-run.json`                | Dry-run verification exists; it never counts as publication                             |
| Post-publication CTA verification     |  2-4 | Publication connector extension               | G6 verifies URL, visibility, artifact hash, CTA, thumbnail, and captions                |
| Campaign retrospective                |  1-4 | Mission retrospective                         | Measurement evidence exists after verified publication                                  |
| Customer-branded video package        |  0-4 | `video-production.json` plus customer overlay | `KYBERION_CUSTOMER` resolves brand and marketing policy without cross-customer fallback |

All external publication is a Distribution responsibility and requires an authenticated human approval bound to the exact effect payload. Strategy, Creative, and Review roles have no publication authority.

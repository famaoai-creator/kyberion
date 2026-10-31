---
title: Roles Directory — Org Role Reference
category: Roles
tags: [roles, persona, procedure, mission-lifecycle]
importance: 6
author: Ecosystem Architect
last_updated: 2026-10-21
kind: reference
scope: global
applies_to: [missions, roles]
owner: knowledge_steward
status: active
---

# Roles Directory — Org Role Reference

Each subdirectory here (`business_owner/`, `qa_lead/`, `solution_architect/`, …) is one
**Org Role** (historically "assigned persona"; selected with `--persona`) a mission can be
assigned to at activation — not the runtime `Persona` identity class, and not to be confused with
a task's **team role** (`implementer`/`reviewer`/`qa`/`tester`/`planner`/`designer`/…, assigned
per-task from `knowledge/product/orchestration/mission-team-templates.json`). See [Role terms](../../../docs/GLOSSARY.md#role-terms) in the glossary for all four role words.

Each persona directory holds:

- `mission.md` — the role's mission statement (why this persona exists).
- `PROCEDURE.md` — the role's standard operating procedure (how it works day to day).

## How a persona's PROCEDURE.md reaches a running mission

1. **Assignment**: `mission_controller start <ID> --persona <role_slug>` (default: `worker`,
   which has no directory here — no procedure gets injected for the default).
2. **Mirroring**: `syncRoleProcedure(missionId, persona)`
   (`libs/core/mission/mission-governance.ts`) runs once at mission activation. If
   `knowledge/product/roles/{persona}/PROCEDURE.md` exists, it's copied into the mission
   directory as `ROLE_PROCEDURE.md`. If the persona has no matching directory, this is a
   silent no-op (logged as a warning) — check the mission log if a procedure you expected
   isn't showing up.
3. **Injection**: `buildRolePersonaProcedureInjectionProvider`
   (`libs/core/mission/mission-orchestration-worker.ts`) reads that `ROLE_PROCEDURE.md` back and
   registers it as a one-shot dynamic injection — it enters the first task's worker prompt
   for that mission, and re-fires after any context-compaction event, the same lifecycle
   `working-principles` uses (`libs/core/dynamic-injection.ts`).

Renaming a persona directory or moving `PROCEDURE.md` breaks step 2 silently (falls through to
"no procedure found, using default") rather than erroring — grep for the slug in
`libs/core/mission/mission-governance.ts` before renaming.

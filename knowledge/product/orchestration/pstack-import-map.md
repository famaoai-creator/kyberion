---
title: 'pstack Import Map — selective distillation into Kyberion'
tags: [orchestration, harnessing, pstack, import-map, playbook]
last_updated: 2026-11-01
runtime_stages: [alignment, execution, review]
---

# pstack Import Map

Selective distillation of Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/main/pstack)
(MIT) into Kyberion. Same posture as the harness2 import: **land inside the governance
envelope, never beside it**. Upstream is a Cursor skill stack with `/poteto-mode` as a
task router; Kyberion already routes via work-scope, mission-class playbooks, and the
Intent Loop — so the router itself is out of scope.

Scratch checkout used for this map: `active/shared/tmp/pstack-review/cursor-plugins/pstack`
(regenerate with a sparse clone of `cursor/plugins` → `pstack` if needed).

## Do not import

| Upstream                                                                           | Why                                                                  |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `/poteto-mode` + 23-playbook auto-router                                           | Competes with work-scope / mission kickoff / Intent Loop             |
| Hard-coded Grok/Opus role panels                                                   | Covered by `reasoning-backend-policy.json`                           |
| Cursor-only surfaces (Bugbot triage, control-ui, overnight GitHub autopilot as-is) | Host-specific; mission_controller + PR readiness already own landing |
| Full `unslop` / `no-comments` stacks                                               | Style layer; optional later as thin prose guidance                   |
| Literally spawning `poteto-agent` / Cursor Task wrappers                           | Use Kyberion `delegateTask`, WorkItems, and review-task independence |

## Landed — MSN-PSTACK-IMPORT-20261101

| Concept                                  | Kyberion landing                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bug fix playbook                         | [engineering-bug-fix-playbook](./engineering-bug-fix-playbook.md)                                                                                 |
| Feature playbook                         | [engineering-feature-playbook](./engineering-feature-playbook.md)                                                                                 |
| Attack the Premise / Sequence / Subtract | [working-philosophy](../governance/working-philosophy.md) §11–13 + `libs/core/working-principles.ts`                                              |
| `create-verification-skill`              | [create-verification-skill-playbook](./create-verification-skill-playbook.md) + `plugins/kyberion-agent-plugin/skills/create-verification-skill/` |

## Landed — MSN-PSTACK-EXT-20261101

| Concept                                     | Kyberion landing                                                                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hillclimb                                   | [hillclimb-playbook](./hillclimb-playbook.md)                                                                                                                           |
| Perf issue                                  | [engineering-perf-playbook](./engineering-perf-playbook.md)                                                                                                             |
| Refactoring                                 | [engineering-refactoring-playbook](./engineering-refactoring-playbook.md)                                                                                               |
| Investigation + how/why evidence categories | [engineering-investigation-playbook](./engineering-investigation-playbook.md)                                                                                           |
| Blast radius                                | [blast-radius-playbook](./blast-radius-playbook.md)                                                                                                                     |
| Benchmark checklist / Explain the Number    | [benchmark-checklist-playbook](./benchmark-checklist-playbook.md) + philosophy §14                                                                                      |
| `/correct` / Encode Lessons                 | [agent-mistake-correction-playbook](./agent-mistake-correction-playbook.md) + [kyberion-development-practices](../governance/kyberion-development-practices.md) pointer |
| `show-me-your-work` decision trail          | [decision-trail-playbook](./decision-trail-playbook.md) (complements mission ledger; does not replace it)                                                               |
| Arena / interrogate / swarm                 | [design-divergence-playbook](./design-divergence-playbook.md) → existing `devils_advocate`, best-of-N, WorkItems/leases                                                 |
| Build the Lever / Fix Root Causes           | working-philosophy §15–16 + `working-principles.ts` full core                                                                                                           |

## Wired into workflow / team (MSN-PSTACK-WIRE-20261101)

| Surface                                             | Change                                                                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `mission-class-playbooks.json` → `code_change`      | Stage `know_how` cites engineering / verify / blast-radius / hillclimb / mistake-correction playbooks                         |
| `mission-class-playbooks.json` → `product_delivery` | verification + retrospective know_how point at the same engineering set                                                       |
| `knowledge-slices.json`                             | Pins for implementer@development, tester, reviewer, devils_advocate                                                           |
| `team-composition-obligations.json`                 | `code-change-design-divergence` requires `devils_advocate` when code_change/product_delivery ∩ approval_required\|high_stakes |
| Role `PROCEDURE.md`                                 | software_developer, qa_lead, performance_engineer, ruthless_auditor — short playbook pointers                                 |

## Still out of scope (intentionally)

| Concept                               | Notes                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| Overnight / autopilot-full merge bots | Use mission babysit + PR readiness; do not copy Cursor GitHub automation wholesale |
| Visual parity pixel harness           | Prefer existing visual/media verification when a concrete need appears             |
| Formal verification skill generators  | Separate track; Kyberion may add later under eval/formal gates                     |
| ketchup / bro / unslop as always-on   | Operator UX style; not engineering workflow                                        |

## Import rules

1. Rewrite in Kyberion vocabulary: evidence, actuators (`pnpm kyberion read|see|…`),
   `record-evidence`, secure-io, tenant tiers — never paste Cursor Task/`poteto-agent` prose.
2. Prefer knowledge playbooks + `working-principles` injection over a second always-on mode.
3. Attribute MIT upstream in the PR Knowledge section when shipping distilled text.
4. Promote only after a real task uses the playbook or skill once (dog-food).

---
title: 'Create Verification Skill Playbook — project-local surface proof for agents'
tags: [orchestration, verification, skill, playbook, pstack, evidence]
last_updated: 2026-11-01
runtime_stages: [execution, verification]
---

# Create Verification Skill Playbook

Distilled from pstack's `/create-verification-skill` (MIT; see [pstack-import-map](./pstack-import-map.md)).
Kyberion already has [procedure-success-check-playbook](./procedure-success-check-playbook.md) for
**recorded procedures** (browser/service golden scenarios). This playbook covers the complementary
gap: a **project-local skill** that teaches the next agent how to launch, doctor, drive, and prove
behavior on the app's real surface (CLI, UI, API, desktop).

The portable skill lives at
`plugins/kyberion-agent-plugin/skills/create-verification-skill/SKILL.md`.
Prefer that skill text when generating; this playbook is the orchestration overview and
governance glue.

## When to use

- A feature or bug fix needs "prove it on the real surface" and no reusable drive recipe exists.
- Multiple agents will verify the same app and would otherwise reinvent selectors and launch steps.
- Overnight / unattended runs need a doctor + evidence contract the operator can audit.

Skip when a golden procedure already covers the path, or when the change is a one-line edit with
an existing unit/integration check that exercises the same observable.

## Governance constraints

- Interview the **repo**, not the operator, for launch/drive/observe facts; ask only what code
  cannot answer.
- Prefer Kyberion actuators and sense verbs over hand-rolled parsers (`pnpm kyberion read|see|…`,
  browser / terminal / system actuators).
- Proof artifacts land under mission evidence or `active/shared/` floors
  (`tmp` / `staging` / `cache` / `runtime`) — never ad-hoc directories; tenant data never under
  `system/`.
- File I/O via `@agent/core/secure-io` in any generator scripts you add.
- Generated skills are agent-facing instructions. Prove them once end-to-end before handoff; a
  never-executed skill is a draft.
- Do not weaken journeys to make them pass. Unreachable paths report the unmet precondition.

## Outcome

1. `.cursor/skills/verify-<app>/SKILL.md` (or the host's skill root) with Launch / Doctor / Drive /
   Evidence / Cleanup.
2. A feature map under `features/` (README index + one file per top feature).
3. One successful drive of a mapped feature with surviving evidence after cleanup.
4. Mission `record-evidence` pointing at that proof when this runs inside a mission.

## Related

- Skill: `plugins/kyberion-agent-plugin/skills/create-verification-skill/SKILL.md`
- [engineering-bug-fix-playbook](./engineering-bug-fix-playbook.md) /
  [engineering-feature-playbook](./engineering-feature-playbook.md)
- [procedure-success-check-playbook](./procedure-success-check-playbook.md)
- [working-philosophy](../governance/working-philosophy.md) — Done requires evidence

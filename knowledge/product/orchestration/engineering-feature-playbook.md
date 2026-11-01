---
title: 'Engineering Feature Playbook — understand, design checkpoint, build, surface proof'
tags: [orchestration, engineering, feature, verification, playbook, pstack]
last_updated: 2026-11-01
runtime_stages: [alignment, execution, verification]
---

# Engineering Feature Playbook

Distilled from pstack's Feature playbook (MIT; see [pstack-import-map](./pstack-import-map.md)).
Rewritten for Kyberion governance. Use for **new or changed product behavior** with a named
acceptance check. Discovery / creative scratch (unknown selectors, media look) stays scratch-first
per AGENTS.md, then promotes — this playbook starts once the shape is agree-able.

## Owner stance

You own the design integrity. Prefer the smallest change that meets the success condition.
Throughput without quality is not the goal — parallelize only after units are verifiable.

## Steps

1. **Understand before editing.** Walk the affected subsystem as it exists today (call sites,
   data shapes, ownership). Prefer computing facts (`rg`, tests, actuator reads) over recalling
   them. If the goal and the task wording conflict, surface the conflict in needs — do not
   satisfy the letter while missing the purpose.

2. **Name the data shape first.** Encode the domain in a structure (typed model, table/registry,
   state machine, boundary) instead of scattered conditionals. Match surrounding idiom; find a
   similar implementation before inventing a new pattern.

3. **Write a throughput checkpoint** (four items; use `n/a: <reason>` rather than dropping):
   - **Blocking first steps** — gates that must run before fan-out.
   - **Independent workstreams** — disjoint files/services that may parallelize.
   - **Shared mutable state** — prefer separate worktrees / leases over locking the same file
     (multi-provider co-execution contract).
   - **Smallest safe decomposition** — if one worker is best, say why.

4. **Subtract before you add.** Remove dead paths, stub references, and redundant validators
   that the feature would otherwise have to carry — then build on the simpler base.

5. **Implement in verifiable units.** One change, narrowest check that could prove it wrong,
   then the next. When several designs are plausible and the choice matters, run competing
   sketches or an independent dissenting review (`devils_advocate` / independent `review-task`)
   before locking the shape — do not silently pick.

6. **Verify on the matching surface.** Exercise the real user or operator path, not only unit
   tests or "it compiles." Capture command output, UI evidence, or actuator receipts under
   mission evidence. If the repo has no scripted drive path, follow
   [create-verification-skill-playbook](./create-verification-skill-playbook.md) first.

7. **Ship through governance.** Ordered commits that a reviewer can replay; `record-evidence`
   for each closed task; independent review for review-kind tasks; PR readiness checklist before
   `pnpm kyberion pr create`.

## Reply shape

What you built, what you chose and why, the throughput checkpoint, open decisions. Prefer a
short table for design alternatives that were considered.

## Related

- [engineering-bug-fix-playbook](./engineering-bug-fix-playbook.md)
- [working-philosophy](../governance/working-philosophy.md)
- [mission-kickoff-playbook](./mission-kickoff-playbook.md)
- [mission-class-playbooks](../governance/mission-class-playbooks.json) — business-class posture;
  this playbook is the engineering execution layer underneath `product_delivery`

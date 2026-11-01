---
title: 'Engineering Refactoring Playbook — pin behavior, reshape, prove equivalence'
tags: [orchestration, engineering, refactoring, verification, playbook, pstack]
last_updated: 2026-11-01
runtime_stages: [execution, verification]
---

# Engineering Refactoring Playbook

Distilled from pstack Refactoring (MIT; see [pstack-import-map](./pstack-import-map.md)).
**Structure changes; behavior does not.** New behavior → feature playbook. Correctness defect →
bug-fix. Missing feature discovered mid-cleanup → split out; ship the structural change first
against the pinned contract.

## Steps

1. **Pin the behavior contract** before any move: characterization test, snapshot, or equivalence
   harness. Typecheck/lint alone are not a pin. No coverage → write the pin first.
2. **Name the missing structure** (typed model, registry, state machine) — reshape must delete
   branches or invalid states, not add indirection.
3. **Name the target shape** as if built today. Cross-boundary designs get an explicit design pass
   or [design-divergence-playbook](./design-divergence-playbook.md) when contested.
4. **Subtract before you add** — dead code, one-caller wrappers, redundant validators, orphans.
5. **Move in small behavior-preserving steps**, each keeping the pin green. Migrate callers and
   delete the legacy API in one wave — no long-lived shims. Spot-check renames in strings/docs.
6. **Prove equivalence** on the real artifact (output diff, baseline replay, or surface smoke) —
   not "it compiles."
7. **Confirm reduced reader load.** If the diff does not lower it somewhere, revert.
8. Ordered commits: subtraction → reshape → cleanup. `record-evidence` with pin + equivalence proof.

## Reply shape

Structure changed, pin held, equivalence proof, reader-load delta, what shipped vs reverted.

---
title: 'Procedure: Targeted Code Refactoring'
tags: [refactoring, procedure, superseded]
last_updated: 2026-11-03
---

# Procedure: Targeted Code Refactoring

> **Canonical path**: structure-only code work uses mission type `refactoring`
> (class `code_change`) and
> [`engineering-refactoring-playbook.md`](../../../product/orchestration/engineering-refactoring-playbook.md)
> via workflow `code-refactoring-aidlc`. Do not use freehand string replace as the
> agent refactoring method.

## 1. Goal

Preserve observable behavior while changing structure. Behavior pins and
equivalence proof are mandatory; build/lint alone are not enough.

## 2. Governed route

1. Start or classify with `--mission-type refactoring` (or an utterance that
   clearly asks for リファクタリング / refactoring).
2. Follow **audit → pin → atomic reshape → equivalence** in the engineering
   playbook. One smell per change set; red steps revert (Mikado).
3. Record evidence that `scripts/check/check_refactoring_evidence.ts` can validate
   (`refactor-audit.json`, pin / reshape / equivalence reports).

## 3. What this procedure is not

- Not a persona/fidelity drift fix — that is
  [`fidelity-refactoring-protocol.md`](../../../product/architecture/fidelity-refactoring-protocol.md)
  (different meaning of "refactoring").
- Not the Code-Actuator `refactor` string-replace action as the primary agent
  method. Actuator ops may assist deterministic edits inside an already pinned
  plan; they do not replace characterization or equivalence gates.

## 4. Expected Output

Pinned behavior held, structural delta under budget, equivalence proof recorded,
reader-load improved or the change reverted.

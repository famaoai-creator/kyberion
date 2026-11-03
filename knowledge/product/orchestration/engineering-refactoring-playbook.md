---
title: 'Engineering Refactoring Playbook — pin behavior, reshape, prove equivalence'
tags: [orchestration, engineering, refactoring, verification, playbook, pstack, agent]
last_updated: 2026-11-03
runtime_stages: [planning, contract_authoring, execution, verification, delivery]
workflow_ids: [code-refactoring-aidlc]
---

# Engineering Refactoring Playbook

Distilled from pstack Refactoring (MIT; see [pstack-import-map](./pstack-import-map.md)) and
external AI-agent refactoring practice (sources below).
**Structure changes; behavior does not.** New behavior → feature playbook. Correctness defect →
bug-fix. Missing feature discovered mid-cleanup → split out; ship the structural change first
against the pinned contract.

Use mission type `refactoring` (class stays `code_change`) so the `code-refactoring-aidlc`
workflow binds this playbook. Do not mix feature or bugfix work into a refactoring mission.

## Agent loop: audit → reshape → verify

Agents break the two quiet assumptions of classic refactoring (the editor understood the code;
a green suite means behavior held). Treat an agent refactor as a deploy: version the audit,
gate the diff on verify, and roll back without ceremony when verify disagrees.

```
     audit  ->  reshape  ->  verify
       ^                         |
       |_________________________|
          (re-score the same audit after merge)
```

1. **Audit (scope contract)** — Pick a bounded target (module / package / hot file), score smells
   with numbers (coupling, cycles, complexity × churn, dead code), name exclusions, set budgets
   (`max_files`, `max_loc`, `max_runs`). Write the audit to disk under mission evidence with a
   content hash. No audit → no reshape. Prefer high-impact, low-ambiguity targets; skip components
   with unclear business logic or dense external dependencies until a human owns the contract.
2. **Pin before cut** — Characterization / golden / equivalence harness against _current_
   observable behavior, bugs included (Hyrum-aware). Typecheck/lint alone are not a pin. Commit
   the pin separately before any production edit.
3. **Plan, then patch** — Written plan: files touched, public-API impact, edit order, behavior
   that must not change. Review the plan before generating the diff. One smell → one PR.
4. **Atomic reshape** — One named transformation per commit (`Extract`, `Rename`, `Inline`,
   `Move`, …). Prefer deterministic/AST ops (IDE rename, codemod, ast-grep) over freehand edits.
   Prefer high-level refactoring _goal_ over rigid step recipes when the model reasons well, but
   keep each landed commit atomic and revertible. Tests stay frozen while production moves;
   production stays frozen while tests move.
5. **Red → revert, don't fix-forward** — A red step means restore and take a smaller step
   (Mikado). Debugging forward from a half-refactored tree turns a refactor into a behavior change.
6. **Verify beyond `tests pass`** — Required signals:
   - Characterization green _unchanged_
   - Test-diff review (weakened asserts = fail)
   - Real-artifact equivalence (output diff, baseline replay, or surface smoke)
   - Structural re-score of the audit smells (target smell down; no new cycle/coupling spike)
     Optional where they fit: property checks, IO-boundary trace diffs.
7. **Public API / delete dead code** — Exported renames need an explicit human owner. "No callers"
   is not proof of no production callers — confirm before deletion.
8. **Close** — Report metric/readability delta; metric gain with readability loss is a failed
   refactor. Ordered commits: subtraction → reshape → cleanup. `record-evidence` with audit +
   pin + equivalence proof.

## Hard stops

- Editing a characterization/golden test to make a reshape pass → stop; that is a behavior change.
- Mixing feature/bugfix into a `refactor:` commit → split the mission.
- Hitting the audit budget → re-audit; do not "approve with a note."
- One-shot "clean this module" prompts that produce multi-thousand-LOC diffs → reject; demand
  plan-then-patch under budget.

## Reply shape

Audit smell + budget, pin held, equivalence proof (per dimension), reader-load delta, public-API
delta (none | human-approved), what shipped vs reverted.

## Sources (external)

| Source                                                                                                                    | Takeaway used here                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [Refactoring with Agents: A Playbook (act101)](https://act101.ai/library/ai-refactoring-playbook)                         | audit → reshape → verify loop; characterization + test-diff + trace/property gates; one smell per PR; budget + public-API human sign-off |
| [VS Code: Refactor code without changing behavior](https://code.visualstudio.com/docs/agents/guides/refactor-safely)      | Record caller-visible contract first; add regression pins before edits; don't silently encode bugs as intent                             |
| [refactor-under-tests-loop (SkillDB)](https://skilldb.dev/skills/agentic-loops-skills/refactor-under-tests-loop)          | Characterize including bugs; tiny green steps; revert don't fix-forward; never mix refactor and behavior commits                         |
| [oh-my-agent refactor-engineer](https://github.com/first-fluke/oh-my-agent/blob/main/.agents/agents/refactor-engineer.md) | Safety-net first; hotspot ranking; Mikado on repeated failure; readability verdict                                                       |
| [Refactoring with LLMs (arXiv:2510.03914)](https://arxiv.org/html/2510.03914)                                             | Goal-oriented refactor prompts often beat rigid step recipes; semantics preservation is the success criterion                            |
| [MANTRA (arXiv:2503.14340)](https://arxiv.org/html/2503.14340v2)                                                          | Developer + reviewer multi-agent loop; self-repair only after compile/test failure signals                                               |
| [DX: Enterprise AI refactoring (2025)](https://getdx.com/blog/enterprise-ai-refactoring-best-practices/)                  | Prioritize business-constraint hotspots; regression + human business-logic review; gradual rollout                                       |

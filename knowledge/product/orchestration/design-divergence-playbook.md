---
title: 'Design Divergence Playbook — contested designs via existing Kyberion roles'
tags: [orchestration, engineering, design, review, playbook, pstack]
last_updated: 2026-11-01
runtime_stages: [alignment, execution, review]
---

# Design Divergence Playbook

Maps pstack `arena` / `interrogate` / `swarm` intents onto **existing Kyberion machinery** —
no second multi-model router and no hard-coded Grok/Opus panels (see
[pstack-import-map](./pstack-import-map.md) Do not import).

| pstack move                                  | Kyberion landing                                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Arena (N parallel attempts, graft best)      | Independent worktrees / `delegateTask` with disjoint scopes; optional best-of-N generation paths; compare artifacts with a written rubric |
| Interrogate (adversarial multi-model review) | `devils_advocate` role + independent `review-task` (different actor id); reviewer working principles (refute with evidence)               |
| Swarm (partitioned coverage)                 | WorkItems / parallel subagents with path leases; one aggregated report; shared writes serialize per multi-provider co-execution contract  |

## When to use

- Contested design or "are we sure?" before locking a shape
- Wide blast-radius reviews ([blast-radius-playbook](./blast-radius-playbook.md))
- Several valid implementation shapes (error handling, abstraction, test structure)

Skip for settled one-path changes.

## Rules

1. **Write the comparison rubric before** spawning (delivery, conformance, fidelity, fitness).
   Prefer anonymized artifact comparison when picking among deliverables (harness2 blind-select
   posture — recommend only; human/mission gate decides).
2. **Separate before serializing shared state** — one worktree or lease per writer.
3. Keep only findings a **run proves**; dismiss noise with a concrete reason.
4. Owner reviews diffs and writes their own summary — do not pass through delegate prose.
5. Record the chosen alternative and rejected ones in mission evidence (and a
   [decision-trail](./decision-trail-playbook.md) when the loop is long).

## Reply shape

Alternatives considered (table), chosen option + why, proof that dissent was sought, open risks.

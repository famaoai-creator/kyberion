---
record_id: mem-MSN-UNION-LITERAL-BURNDOWN-PILOT8-20261123-2026_11_23
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-UNION-LITERAL-BURNDOWN-PILOT8-20261123-2026_11_23
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-23T04:46:11.452Z
source_branch: agent/factory-pilot8-literal-burndown
source_commit: 118d1698b6a29f84f37c8ef95c930c71b70e82c1
---

# Union-literal convergence: predicates, type guards, leaf vocabulary, display mirrors

How to burn down union-literal branches onto canonical projections without breaking narrowing, imports, or the client/server module boundary.

## Hint Scope

mission

## Trigger Phrases

- Burning down union-literal branches: (1) convert comparisons to owner-module predicates; use `x is Extract<U,{kind:K}>` type guards (or generic `C & {kind:K}`) wherever the caller consumes narrowed members, plain booleans only when no narrowing is needed. (2) Prefer Record-typed tables keyed by the union member for fan-out logic. (3) When a predicate creates an import cycle, sink the union vocabulary + predicates to a leaf module both sides import. (4) Client components cannot import server-dep core modules — keep display-side canonical mirrors and let the gate baseline them as owner-adjacent. (5) Never register an inline union whose sibling literals collide with other domains; use a structural discriminator field instead. (6) After moving or adding predicate definitions, regenerate the shrink-only baseline with --write-baseline rather than hand-editing it.

## Recommended References

- active/missions/public/MSN-UNION-LITERAL-BURNDOWN-PILOT8-20261123/evidence/retrospective.md
- active/missions/public/MSN-UNION-LITERAL-BURNDOWN-PILOT8-20261123/evidence/implementation-report.md
- active/missions/public/MSN-UNION-LITERAL-BURNDOWN-PILOT8-20261123/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-UNION-LITERAL-BURNDOWN-PILOT8-20261123/evidence/retrospective.md
- active/missions/public/MSN-UNION-LITERAL-BURNDOWN-PILOT8-20261123/evidence/implementation-report.md
- active/missions/public/MSN-UNION-LITERAL-BURNDOWN-PILOT8-20261123/evidence/REVIEW-execution-implement.md

## Artifacts

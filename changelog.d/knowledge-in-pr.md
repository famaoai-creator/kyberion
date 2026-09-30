---
category: Changed
---

- **Mission learnings ship in the same PR as the code** — distillation and product-domain promotion now happen before the PR. `memory-approve --approval-channel pr_review` makes the PR review the steward review. `memory-promote --target-root <worktree>` writes the record into the feature branch and stamps it with `source_branch` / `source_commit`. `pnpm kyberion pr create` blocks, with no skip flag, when a mission candidate is unresolved or undeclared under the new `## Knowledge` PR-template section, when a promoted record is missing from the diff, or when the diff touches `knowledge/confidential/` or `knowledge/personal/`. `finish` ratifies `pr_review` candidates by confirming the record exists on `origin/main`.

---
title: Kyberion Development Workflow
category: Orchestration
tags: [orchestration, development, workflow, evidence, github, mission]
importance: 9
author: Ecosystem Architect
last_updated: 2026-07-07
---

# Kyberion Development Workflow

This document defines the repo-native development loop for Kyberion.

It ties together:

- local Git branch and worktree hygiene
- mission and workitem coordination
- evidence capture and traceability
- PR validation on GitHub Actions

If this document conflicts with a lower-level operational guide, the lower-level guide wins for its own narrow scope.

## Source of Truth

Use these documents together:

- [`git-flow-standards.md`](./git-flow-standards.md) for branch and worktree discipline
- [`work-coordination-platform.md`](./work-coordination-platform.md) for mission/workitem coordination
- [`.github/workflows/pr-validation.yml`](../../../.github/workflows/pr-validation.yml) for the required PR gate
- [`.github/PULL_REQUEST_TEMPLATE.md`](../../../.github/PULL_REQUEST_TEMPLATE.md) for the PR evidence contract

## Operating Model

Kyberion development has two coupled planes:

1. The **coordination plane** keeps the work explicit.
   - missions define the durable objective
   - workitems define bounded execution slices
   - coordination records keep status, handoffs, and blockers visible
2. The **delivery plane** turns that work into a reviewable GitHub PR.
   - the branch carries the implementation
   - the PR carries the evidence
   - GitHub Actions enforces the publish gate

The development loop should preserve both planes. If the Git side passes but the mission evidence is unclear, the work is not complete. If the mission state is correct but the PR is missing validation, the work is not publishable.

## Standard Workflow

1. Update `origin/main` first.
2. Create a new worktree from that base.
3. Decide whether the change belongs to one mission or several:
   - keep dependent changes in the same worktree
   - split only when the work is independently reviewable
4. Register or update the mission and its workitems.
5. Implement one bounded slice at a time.
6. Capture evidence and traces while you work.
7. Run targeted validation for the slice.
8. Before PR publish, run the repo checks required for the change.
9. Open or update the PR with the evidence bundle.
10. After review comments, revise the same branch and worktree.
11. After merge, fast-forward `origin/main` and clean up the worktree.

## Evidence Contract

Every publishable change should be able to answer these questions:

- What mission does this belong to?
- Which workitems were executed?
- What evidence files were produced?
- What traces or logs support the claim?
- What commands verified the change locally?
- Which PR and CI run validated the final state?

Recommended minimum fields in the PR body:

- `Mission ID`
- `Workitem IDs`
- `Evidence paths`
- `Trace IDs`
- `Validation commands`
- `CI result`

Recommended minimum evidence artifacts:

- a mission evidence directory or equivalent scoped evidence folder
- a trace or log path for the execution
- a concise decision / summary note

## Branch and Worktree Rules

- Start from `origin/main`.
- Create a dedicated worktree for the change.
- Keep mutually dependent files together in the same worktree.
- Do not split a single logical fix across multiple worktrees unless the split is intentional and reviewable.
- Keep the branch name aligned with the published scope.

See [`git-flow-standards.md`](./git-flow-standards.md) for the branch-level rules.

## Mission and Workitem Rules

- Use a mission when the change has durable state, multiple steps, or more than one evidence artifact.
- Use workitems to keep the execution slice bounded.
- Keep workitem outputs explicit and reviewable.
- When a workitem is blocked, record the blocker instead of silently retrying.
- When a workitem completes, record the output path and any trace or evidence path it produced.

See [`work-coordination-platform.md`](./work-coordination-platform.md) for the coordination model and storage layout.

## Validation Ladder

Use the lightest check that still proves the change.

1. Slice-level checks:
   - targeted tests for the changed area
   - schema or contract checks when the change is data-shaped
2. Pre-publish checks:
   - `pnpm validate` for broad or cross-cutting changes
   - `pnpm check:pr-title -- --title "<proposed title>"`
3. GitHub gate:
   - `pr-validation.yml` must pass before merge
   - if the PR title gate fails, fix the title before re-running

If a change modifies a stable surface, follow the surface-specific versioning and rebaseline guidance before publish.

## Review Loop

Review comments are not a separate branch.

- keep the same branch
- keep the same worktree when possible
- update the mission/workitem record if scope changes
- add new evidence if the review request introduces a new claim
- re-run the relevant validation before pushing the fix

If the review reveals a new, independent workstream, spawn a new worktree and PR for that work instead of inflating the current one.

## Merge and Cleanup

After merge:

1. fast-forward local `main` to `origin/main`
2. remove or prune the branch-owned worktree
3. delete temporary artifacts that were only needed for the PR
4. keep long-lived evidence only if it belongs in the repo or mission record

## Practical Default

When in doubt, use this order:

1. mission
2. workitem
3. evidence
4. local validation
5. PR
6. GitHub Actions

That keeps the internal coordination state and the external delivery state aligned.

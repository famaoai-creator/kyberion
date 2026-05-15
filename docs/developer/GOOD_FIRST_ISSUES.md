# Good First Issues

This page breaks larger roadmap work into small tasks that are suitable
for first-time contributors. The goal is a task that fits in roughly
1-2 hours, has a clear test, and touches a single area.

## How to use this list

Pick one task, file or claim the matching issue, and keep the scope
small. If the task touches a stable surface, update the relevant contract
test or semver baseline.

## 1-2 hour task contract

A starter task is ready to file when it has all of the following:

- Estimated time: 1-2 hours.
- Files expected: one file or one small file cluster in one area.
- Validation command: one targeted command that proves the change.
- Out of scope: the nearby work that the contributor should not expand into.
- Maintainer contact: the CODEOWNER or area owner who can answer questions.

If a task needs architecture decisions, broad refactors, secrets, live
service credentials, or multi-area coordination, keep it off the
`good-first-issue` label and file it as a normal roadmap task.

## Starter slices from P1/P2

| Slice | Files expected | Validation command | Out of scope |
|---|---|---|---|
| Add one `classifyError` rule for a real unknown error | `libs/core/error-classifier.ts`, `libs/core/error-classifier.test.ts` | `pnpm exec vitest run libs/core/error-classifier.test.ts` | Reworking classifier categories or CLI logging |
| Add one meeting dry-run assertion | `libs/core/meeting-participation-coordinator.test.ts` or `libs/actuators/meeting-browser-driver/src/index.test.ts` | `pnpm run test:meeting-dry-run` | Joining a real meeting or changing browser automation behavior |
| Add one release workflow contract assertion | `tests/release-operations-contract.test.ts`, `docs/developer/RELEASE_OPERATIONS.md` | `pnpm exec vitest run tests/release-operations-contract.test.ts` | Designing a new release process |
| Add one cross-OS workflow wording check | `.github/workflows/cross-os.yml`, `tests/workflow-operations-contract.test.ts` | `pnpm exec vitest run tests/workflow-operations-contract.test.ts` | Changing the OS matrix or adding new CI jobs |
| Add one first-win docs phrase | `README.md`, `docs/QUICKSTART.md`, `docs/WHY.md`, `tests/first-win-docs-contract.test.ts` | `pnpm exec vitest run tests/first-win-docs-contract.test.ts` | Rewriting the product positioning |
| Update one developer tour path | `docs/developer/TOUR.md`, `tests/developer-tour-contract.test.ts` | `pnpm exec vitest run tests/developer-tour-contract.test.ts` | Reorganizing developer documentation |
| Tighten one meeting guide safety sentence | `docs/user/meeting-facilitator.md`, `tests/user-meeting-use-case-contract.test.ts` | `pnpm exec vitest run tests/user-meeting-use-case-contract.test.ts` | Changing consent behavior or runtime code |
| Improve the good-first-issue issue template copy | `.github/ISSUE_TEMPLATE/good-first-issue-guide.md`, `tests/good-first-issue-guidance-contract.test.ts` | `pnpm exec vitest run tests/good-first-issue-guidance-contract.test.ts` | Changing labels or repository triage policy |

## Backlog categories

Use these categories when creating more starter slices:

- Docs: one concrete paragraph, command, or link in `README.md`, `docs/`,
  or `knowledge/public/architecture/`.
- Tests: one regression or contract assertion around existing behavior.
- Core: one narrow guardrail, classifier rule, trace event, or lifecycle
  invariant with an adjacent unit test.
- Meeting: one dry-run, consent, redaction, or summary-output assertion.
- Release / CI: one workflow, migration, changelog, or release-note
  contract assertion.

## Issue template guidance

When filing a good-first-issue, include:

- Estimated time: 1-2 hours.
- Files expected: the one file or one small file cluster to touch.
- Validation command: the exact command that should pass after the change.
- Test that should fail first, when applicable.
- Out of scope: nearby work that should remain untouched.
- Surface or doc area the change belongs to.

If the change needs broad coordination, it is not a good-first-issue.

# Good First Issues

This page breaks larger roadmap work into small tasks that are suitable
for first-time contributors. The goal is a task that fits in roughly
1-2 hours, has a clear test, and touches a single area.

## How to use this list

Pick one task, file or claim the matching issue, and keep the scope
small. If the task touches a stable surface, update the relevant contract
test or semver baseline.

## Starter slices

### Docs

- Add a short troubleshooting note for `pnpm doctor` failure modes.
- Split one section from `docs/user/meeting-facilitator.md` into a
  task-specific page.
- Add Japanese wording to an English-only user doc.

### Tests

- Add a contract test for a new workflow step in `tests/`.
- Extend a docs contract test when a path or command changes.
- Add a regression test for a guardrail that already exists in code.

### Core

- Add one new rule to `libs/core/error-classifier.ts`.
- Add a single missing `trace` event on an existing failure path.
- Tighten one `secure-io` or `tier-guard` check with an existing test.

### Meeting

- Add one field to the meeting use-case summary output.
- Add a small contract test for `meeting-actuator` schema examples.
- Improve one message in the meeting participation bootstrap gate.

### Release / CI

- Add one assertion to the release workflow contract test.
- Add one line to the release notes extraction helper test.
- Reword one step in the cross-OS workflow and update the contract test.

## Issue template guidance

When filing a good-first-issue, include:

- the one file or one small file cluster you expect to touch,
- the exact command that should pass after the change,
- the test that should fail before the change,
- and the surface or doc the change belongs to.

If the change needs broad coordination, it is not a good-first-issue.

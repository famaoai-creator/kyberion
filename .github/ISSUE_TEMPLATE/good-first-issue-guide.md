---
name: "Good First Issue (maintainer template)"
about: "(For maintainers) Template to scaffold a well-scoped good-first-issue"
title: "[good-first-issue] "
labels: good-first-issue, help-wanted
---

<!--
For maintainers: use this template when filing issues you want first-time
contributors to take on. The pattern below makes them low-friction to pick up.
-->

## What needs to be done

<!-- Describe the change in 1–2 sentences. -->

## Why this is a good first issue

- Estimated time: 1-2 hours
- Files expected: <!-- e.g., libs/core/error-classifier.ts and libs/core/error-classifier.test.ts only -->
- Validation command: <!-- e.g., pnpm exec vitest run libs/core/error-classifier.test.ts -->
- Out of scope: <!-- e.g., classifier taxonomy changes, unrelated CLI logging -->
- No deep system knowledge required.
- Existing tests cover the surrounding code.

## Steps

1. <!-- e.g., Read libs/core/error-classifier.ts -->
2. <!-- e.g., Add a new rule for 'X' -->
3. <!-- e.g., Add tests in error-classifier.test.ts -->
4. <!-- Run `pnpm vitest run libs/core/error-classifier.test.ts` and verify -->

## Example slices

- Add a troubleshooting note for `pnpm doctor`.
- Split one section from `docs/user/meeting-facilitator.md` into a smaller page.
- Add one rule to `libs/core/error-classifier.ts` and a matching test.
- Reword one release workflow step and update the contract test.

See [`docs/developer/GOOD_FIRST_ISSUES.md`](../../docs/developer/GOOD_FIRST_ISSUES.md) for a fuller list.

## Acceptance

- [ ] Good first issue checklist is still true: one area, one small file cluster, one validation command, 1-2 hours.
- [ ] Test added that fails before the change.
- [ ] Test passes after the change.
- [ ] No regression in existing tests.

## Maintainer to contact

<!-- Tag a CODEOWNER for the area. -->

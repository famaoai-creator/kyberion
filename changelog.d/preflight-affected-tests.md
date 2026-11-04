---
category: Added
---

- **`pnpm kyberion pr preflight` runs the affected tests**: after `check --changed`, preflight now runs the tests a change touches:
  - For changed code it runs `vitest run --changed <merge-base>`.
  - For changed data and doc files (JSON, YAML, Markdown) it runs the test files whose source names that file, found by path and distinctive basename.
  - It only runs paths that CI's test suites cover, in CI's environment: `LANG=C.UTF-8`, `CI=true`, strict leak checks, and no operator persona or role.
  - It prints vitest's summary and the number of test files that ran. When none ran it says "0 test files ran" rather than reporting a pass.
  - These selections are shown as `NOT RUN` with the reason: a change to `package.json` or the vitest config (which would rerun every test), a search term matching more than 40 tests, and tests outside the CI suites.

  To skip this step, use `--skip-affected-tests` and record the tests as not run in the PR Test plan.

---
category: Added
---

- **`pnpm kyberion pr preflight` runs the affected tests** — after `check --changed`, preflight now runs `vitest run --changed <merge-base>` for changed code and, for changed data / doc files (JSON, YAML, Markdown), the test files whose source names that file (fixed-string search by path and distinctive basename). It prints what it selected and says "No affected tests selected" instead of a pass when nothing applies; a file with more than 40 readers is reported, not run. Use `--skip-affected-tests` to skip it and record the tests as not run in the PR Test plan.

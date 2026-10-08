---
category: Changed
---

- **CI cancels superseded PR runs and stops duplicating suites** — PR workflows now cancel an in-progress run when a newer push arrives, every job has a `timeout-minutes`, `pr-validation` no longer builds `@agent/core` twice, and on pull requests the core/actuators suites run only in `pr-validation` (the `ci.yml` and Linux `cross-os` copies are skipped; they still run on `main` and on schedule). Actions moved to their Node 24 majors. The new `ci-workflow-contract` gate (`pnpm check -- --scope pr`) keeps it that way.

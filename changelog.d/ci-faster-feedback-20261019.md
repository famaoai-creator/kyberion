---
category: Changed
---

- **CI: faster feedback** — `ci.yml` test/smoke jobs no longer wait on `lint-and-validate`, and independent check steps keep running after an earlier one fails, so one push reports every failing signal. `cross-os.yml` reuses one Linux build for the Unix jobs, drops the per-OS typecheck, skips the OS jobs for prose-only PRs, and reports one always-running `cross-os-result` check. The vital-check PR comment is a single marker-identified comment, edited only when the report changes. `ci.yml`, `pr-validation.yml` and `cross-os.yml` also trigger on `merge_group` for merge-queue readiness.

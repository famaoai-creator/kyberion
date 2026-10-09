---
category: Fixed
---

- **Re-evaluated modules no longer break seam registration.** A module that defines a core seam at load time and is evaluated a second time (for example after a module-registry reset in tests) now replaces its own catalog entry and logs a warning, instead of failing with `Seam <key> is already registered in the catalog`. A seam defined by any other module under the same key is still rejected. Seam definitions in `coreSeamCatalog` must declare `owner: '<repo-relative path of the defining module>'`; `libs/core/seam-reevaluation.test.ts` enforces this.
- **Test files no longer share approval-store state.** A new Vitest setup file clears the per-pool test approval store (`active/shared/runtime/vitest-approvals/pool-<n>/`) before and after every test file. With `KYBERION_TEST_LEAK_STRICT=1`, a test file that leaves approval records behind now fails, unless it is listed in `tests/fixtures/approval-store-leftover-baseline.json`. That list only shrinks.

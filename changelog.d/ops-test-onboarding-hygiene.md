---
category: Fixed
---

- **`pnpm work create-item --tenant-slug` works again outside tests.** Tenant validation ran inside the work-coordination store fence, which runs as `infrastructure_sentinel` and may not read the personal-tier tenant registry, so every tenant-scoped create failed with `[ROLE_VIOLATION] ... Sovereign Sanctuary`. Validation now runs under the caller's own authority before the fence. This affected onboarding-flow Step 11, also under a company stance.
- **`pnpm tenant:activation probe` no longer reports a tenant named `tenants`.** `knowledge/confidential/tenants/index.json`, the tenant design-override index, is now a shared registry path. Before, a tenant-bound process that read it got `tenant.scope_violation`.
- **`plan` and `probe` need the same environment.** `pnpm tenant:activation` binds itself to the tenant and organization in `--tenant-slug` / `--organization-id`. Under `KYBERION_TENANT_SCOPE_REQUIRED=true`, `plan` no longer fails with `tenant.scope_missing`, and you no longer need to export `KYBERION_TENANT`.
- **CI fails test runs that write into live `active/` state.** CI sets `KYBERION_TEST_LEAK_STRICT=1`, and `pnpm test -- --suite …` now forwards it to Vitest. The `safeExec` env allowlist used to drop it, so the flag had no effect through `pnpm test`. These now resolve into the Vitest sandbox: intent-contract memory, the audit chain key, the provider discovery cache and the tenant rate-limit state. The arbitration test releases the lock it holds.
- **History search, wisdom `history_search` and CJK PDF tests skip when `sqlite3` or a CJK font is missing.** Before, they failed. `probeHistorySearchBackend()` (in `@agent/core/history-search-index`) reports whether `sqlite3` with FTS5 trigram is available.

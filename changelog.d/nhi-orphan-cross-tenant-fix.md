---
category: Fixed
---

- **NHI orphan scan no longer accuses cross-tenant missions** — `listOrphanNhiIdentities` treated a mission that exists but is invisible to the bound tenant (`OWNER_NOT_VISIBLE` / `OWNER_AMBIGUOUS`) as `mission_scope_missing`, producing baseline-check L9 false positives in any tenant-bound workspace. A new `missionScopeMissing` helper (existence audit semantics, beside `missionPathOrNull` in `mission-lookup.ts`) counts only genuine absence, and a tenant-bound scan skips affiliations it cannot enumerate unless the affiliation pins the bound tenant.

- **CLI help flags behave**: `pnpm scheduler --help` no longer launches the chronos daemon (it used to tick and hang); `pnpm knowledge --help` now exits 0; `pnpm scenario run` prints the real report directories instead of a literal `<run-id>` placeholder.

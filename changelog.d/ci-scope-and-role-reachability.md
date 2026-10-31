---
category: Changed
---

- **The role-assumption reachability report is no longer committed** — `docs/developer/role-assumption-reachability.json` (about 800 KB, changed in about one commit in five) is gone. The `role-assumption-reachability` gate computes reachability in memory and fails only when an RN-03 invariant breaks, for example when code can reach a role that `role-assumption-policy.json` does not grant. Each failure prints the path to the role and what to do next. `node --import ./scripts/ts-loader.mjs scripts/analyze_role_assumptions.ts --write-report` writes the report to `active/shared/cache/system/role-assumption/` when you want to read it.
- **Pull requests run each check gate once** — the new `pnpm check -- --scope full-only` selects the full gates without the pr gates. `ci.yml` uses it on pull requests and in the merge queue, where `pr-validation.yml` already runs `--scope pr`; pushes to `main` and the weekly schedule still run `--scope full`. The governance boundary tests no longer run a second time in `pr-validation.yml` or a third time in the `integration` test shards (`pnpm test -- --suite integration --skip-gate-tests`).

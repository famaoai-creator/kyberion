# Scripts

Executable entry points for Kyberion development, operations, and governance.
Most are wired to `pnpm <name>` in `package.json`, either directly
(`node --import ./scripts/ts-loader.mjs scripts/<file>.ts`) or through the
compiled build (`node scripts/run_built.mjs dist/scripts/<file>.js`).

## Directory Layout

```
scripts/
  *.ts            ← repo-wide operations (one file per entry point)
  check/          ← all `check_*` / `check-*` governance gates + baselines
  generate/       ← all `generate_*` catalog/index generators + their helpers
  sync/           ← all `sync_*` code→knowledge reconciliation syncers
  lib/            ← shared helpers imported by scripts; no entry points
  <domain>/       ← grouped script sets for one bounded area
                    (personal-pads/, meeting-notepad/, daily-desk/,
                    customer-decision/, config/, refactor/, doc-templates/,
                    presence/, demos/, fixtures/, ...)
```

Historically every entry point landed flat in the root. Bounded domains are
being grouped into `<domain>/` subdirectories — the `check_*` governance gate
family moved first (all gates, their tests and `*.baseline.json` files now
live in `check/`; new checkers go there, never in the root), followed by the
`generate_*` catalog/index generators in `generate/`, and the `sync_*`
code→knowledge syncers in `sync/`. Prefer a
subdirectory for new domain-scoped scripts and keep the root for operations
that genuinely span the repository. (Direction set by
[SIMPLICITY_ABSTRACTION_PLAN](../docs/developer/improvement-plans-2026-08/SIMPLICITY_ABSTRACTION_PLAN_2026-08-25.ja.md)
SX-06; not yet enforced by a gate.)

## Conventions

- **One entry point = one file**: `name.ts`, with its unit test beside it as
  `name.test.ts`.
- **Use the harness**: `scripts/lib/harness.ts` re-exports `defineScript` /
  `defineGenerator` from `@agent/core/script-harness` — argv parsing,
  `--json` / `--dry-run`, and exit codes in one place.
- **Shared code goes to `lib/`**, never imported across entry points directly.
- **Qualified test suffixes** mark non-unit checks next to a script:
  - `name.entrypoint.test.ts` — CLI argument-mapping contract
  - `name.contract.test.ts` — cross-module contract
  - `name.resource-boundary.test.ts` / `name.env-boundary.test.ts` /
    `name.output-boundary.test.ts` — storage / environment / output boundary guards
  - `name.integration.test.ts` — cross-component
- **Adding a `pnpm` command**: create the script here, then wire it in
  `package.json` `scripts`.

## References

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — coding conventions and CODEOWNERS per area.
- [`pipelines/README.md`](../pipelines/README.md) — declarative pipelines; prefer a
  pipeline over a new script for repeatable governed work (AGENTS.md §2).

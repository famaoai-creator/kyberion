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
  meeting/        ← `meeting_*` meeting operations entry points
  peer/           ← `peer_*` peer messaging/collaboration entry points
  continuous/     ← `continuous_*` continuous-operations cycle entry points
  task/           ← `task_*` work-item operations (init/list/run/scenario/smoke)
  reconcile/      ← `reconcile_*` config/scope/intent reconciliation sweeps
  dot/            ← `dot_*` Dot charter lifecycle/executor/cadence steps
  browser/        ← `browser_*` + `browser-bridge-*` bridge/executor/profile ops
  stance/         ← `stance_*` stance create/list/switch/migrate ops
  voice/          ← `voice_*` voice setup/consent/route/upgrade CLIs
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
`generate_*` catalog/index generators in `generate/`, the `sync_*`
code→knowledge syncers in `sync/`, and the domain entry-point families
`meeting/`, `peer/`, `continuous/`, `task/`, `reconcile/`, `dot/`, `browser/`, `stance/` and `voice/`. Prefer a
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
- **Moving a script family** (learned from the check/generate/sync/task
  regroups — each of these bit at least once):
  - self-locating `dirname(fileURLToPath(import.meta.url))` arithmetic breaks
    on any depth change — use `pathResolver.rootDir()` instead;
  - `vi.mock('./lib/x.js')` and dynamic `import('./x.js')` specifiers are NOT
    caught by `from './x'` greps — sweep both forms;
  - `pathResolver.rootResolve('scripts/name.ts')` / `` `scripts/${name}` ``
    literals inside the moved files themselves are easy to miss — grep the
    destination dir for its own family prefix after moving;
  - pre-existing `../libs/...` (and `../<repo-dir>/`) imports that were correct
    at root depth need `../../libs/...` after the move — sweep every `../`
    specifier, not just `./`;
  - verify with `pnpm build` (tsc catches missed imports) + the family's
    vitest files + `resolve generated --check` freshness, not just grep.

## References

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — coding conventions and CODEOWNERS per area.
- [`pipelines/README.md`](../pipelines/README.md) — declarative pipelines; prefer a
  pipeline over a new script for repeatable governed work (AGENTS.md §2).

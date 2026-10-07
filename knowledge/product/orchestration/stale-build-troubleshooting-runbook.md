---
title: 'Stale-Build Troubleshooting Runbook'
tags: [runbook, build, dist, baseline-check, troubleshooting]
last_updated: 2026-10-08
runtime_stages: [alignment, execution]
---

# Stale-Build Troubleshooting Runbook

A `dist/` tree older than its TypeScript sources serves stale exports. The
failure surfaces far from the cause — a CLI dies on a "missing export" while
`baseline-check` used to report `all_clear`. This runbook turns that into a
one-pass fix.

## 1. Symptom table

| Error you see                                                                                    | Likely stale target   | Why                                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `SyntaxError: ... does not provide an export named '<X>'` (@agent/core, @agent/shared-ui)        | `libs/<pkg>/dist`     | export added after the last package build                                                                                                 |
| same error on `@agent/shared-{media,nerve,network,vision}`                                       | `dist/libs/<pkg>/`    | their `main` resolves to `dist/libs/<pkg>/src/index.js` — emitted by `build:repo`, not the package build                                  |
| `ERR_MODULE_NOT_FOUND` / `ERR_PACKAGE_PATH_NOT_EXPORTED`                                         | root `dist/`          | dist file imports a subpath the manifest no longer maps                                                                                   |
| `pnpm organization` dies at import time                                                          | `libs/core/dist`      | ts-loader resolves `@agent/core` specifiers to `libs/core/dist` when it exists                                                            |
| `pnpm kyberion` dies at import time                                                              | `libs/core/dist`      | plain Node exports-map resolution to `libs/core/dist` (no ts-loader — `run_built.mjs` runs `dist/scripts/*` directly)                     |
| pipeline ADF step fails inside an actuator op                                                    | `dist/libs/actuators` | `build:actuators` out of date vs `libs/actuators/**`                                                                                      |
| a dist-backed command (`pnpm pipeline`/`mission`/`kyberion`/`project`) behaves like the old code | `dist/scripts`        | `build:repo` not run after the edit — ts-loader facades (`pnpm organization`, `knowledge`, `scope`…) always run source and are unaffected |

## 2. Root cause in one paragraph

`scripts/ts-loader.mjs` intercepts **`@agent/core` specifiers only**: when
`libs/core/dist/<subpath>.js` exists it steps aside and Node's exports map
serves the compiled file — an outdated `libs/core/dist` therefore wins
resolution silently (per-subpath, so a partial dist mixes old and new). All
other workspace packages (`@agent/shared-*`, `@actuator/*`) always resolve to
their package.json `main`/`exports` — `libs/<pkg>/dist` for core and
shared-ui, `dist/libs/<pkg>/src/index.js` for shared-{media,nerve,network,
vision}.

## 3. Confirm before fixing

```bash
pnpm pipeline --input pipelines/baseline-check.json
# needs_recovery + failed_layer L2 -> build problem.
# warnings.stale_dist_targets names the FIRST stale target —
# run the standalone checker for the full list.

node dist/scripts/check_stale_dist.js        # dist-mode (exit 1 = stale, names all targets)
node --import ./scripts/ts-loader.mjs scripts/check_stale_dist.ts   # source-mode — use when dist itself is too broken to boot
```

L2 compares each target's sources against tsbuildinfo `fileInfos` content
hashes (mtime fallback when no buildinfo covers that source root) — a
`touch`ed-but-unchanged file does not false-positive. Target ids map to
ladder rungs below: `root:scripts|presence|satellites`, `libs/actuators`,
`libs/<pkg>` (package build), `dist/libs/<pkg>` (root-emitted tree).

Bootstrap note: the L2 stale-dist leg itself only exists in dist after the
first `build:repo` that included it (MSN-BASELINE-STALEDIST-20261008) — on a
dist older than that, use the source-mode checker above.

## 4. The rebuild ladder — smallest rung first

```bash
pnpm --filter @agent/core run build   # one package dist (libs/<pkg>/dist)
pnpm run build:repo                   # scripts/, presence/, satellites/ AND libs sources -> dist/
pnpm run build:actuators              # libs/actuators/** -> dist/libs/actuators
pnpm run build:packages               # all libs/* package dists
pnpm run build                        # everything incl. bundles + UI
                                      # (clean-builds dist first — re-check only after it completes)
```

Re-check with `check_stale_dist` after each rung — incremental/composite tsc
skips re-emitting unchanged files, which is fine: the check verifies content
hashes, not mtimes.

**Escape hatch when even the checker won't boot** (libs/core/dist so stale
the checker itself can't import): `rm -rf libs/core/dist` — ts-loader then
resolves every `@agent/core` subpath from source, and the source-mode
checker/build commands work again.

## 5. Edge cases

- **`touch`ed source, no content change** — not stale; the tsbuildinfo hash
  proves the build already saw this content.
- **Package with no `libs/<pkg>/dist` at all** — for `@agent/core` the
  ts-loader falls back to source (absence can't serve old exports, so the
  check skips it). Other packages have no source fallback — a missing
  required dist yields `ERR_MODULE_NOT_FOUND`, a different symptom.
- **`dist/.tsbuildinfo` shared by `build:repo` and `build:actuators`** — last
  writer wins; its mtime and hash coverage only count for the targets it
  actually tracks, so the other build's targets degrade to the mtime fallback
  until a full `pnpm run build`.
- **A `libs/<pkg>` source not imported by the root program** — `dist/libs/<pkg>`
  flags it `unrecorded_source` only when the file is newer than the last
  buildinfo write; a rebuild clears it either way (flagging errs toward
  rebuild, never silence).
- **Dirty working tree** — baseline may legitimately report `needs_recovery`
  until you rebuild; that is the check working, not noise.

## 6. Prevention

`system:baseline_check` layer **L2** fails on stale dist (delivered by
MSN-BASELINE-STALEDIST-20261008; `dist/libs/<pkg>` coverage added during
MSN-STALEDIST-RUNBOOK-20261008 review): `needs_recovery` +
`warnings.stale_dist_targets` + `pnpm run build` as the remedy. Run
`baseline-check` at session start per AGENTS.md §3 — a stale build is caught
before it breaks a facade.

# Lockfile change review — esbuild devDependency

- **Date**: 2026-09-28
- **Change**: `pnpm add -Dw esbuild` (devDependencies: esbuild ^0.27.2)
- **Purpose**: `scripts/bundle_entrypoints.mjs` bundles hot dist entry
  points (cli / run_pipeline / mission_controller / surface_runtime /
  chronos_daemon) into single files after `build:repo`, removing the
  per-subpath exports-map resolution cost (~0.3s saved on `run_pipeline`).
- **Security**: esbuild was already in the dependency tree (transitive via
  vitest/vite), is covered by `pnpm-workspace.yaml` `allowBuilds` and the
  pinned `overrides`/`esbuild@>=0.27.3 <0.28.1 -> ^0.28.1` rule. No new
  runtime dependency surface — dev-only tool.
- **Lockfile diff reviewed**: added entries limited to `esbuild` +
  `@esbuild/*` platform binaries.
- **Lockfile digest**: `pnpm-lock.yaml` sha256: 4b636b4cfb9254ef4f7224ed45425f21923a286c66355179518fbb56bebce54a

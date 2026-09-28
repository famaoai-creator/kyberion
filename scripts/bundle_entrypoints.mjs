#!/usr/bin/env node
/**
 * Bundle hot script entry points into single files under dist/scripts/.
 *
 * `pnpm build:repo` (tsc) emits per-file output whose first-run cost is
 * dominated by Node package resolution: every `@agent/core/*` subpath import
 * walks the 1,700-entry exports map and stats a separate file. Bundling the
 * handful of user-facing entry points collapses that into one read each —
 * measured: `run_pipeline --dry-run` 0.66s -> 0.37s.
 *
 * Bundles are written over their dist entry in place so every caller
 * (`pnpm kyberion`, `pnpm pipeline`, spawn paths) benefits unchanged.
 * External packages stay external — only repo-internal code is inlined.
 * Libraries and tests keep per-file output so module-level imports and
 * vitest resolution are unaffected.
 */
import { existsSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY_POINTS = [
  'dist/scripts/cli.js',
  'dist/scripts/run_pipeline.js',
  'dist/scripts/mission_controller.js',
  'dist/scripts/surface_runtime.js',
  'dist/scripts/chronos_daemon.js',
];

async function main() {
  const { build } = await import('esbuild');
  let bundled = 0;
  for (const entry of ENTRY_POINTS) {
    const input = resolve(ROOT, entry);
    if (!existsSync(input)) {
      console.log(`[bundle-entrypoints] skip missing ${entry}`);
      continue;
    }
    const out = resolve(ROOT, entry.replace(/\.js$/, '.bundle.js'));
    await build({
      entryPoints: [input],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node24',
      packages: 'external',
      outfile: out,
      logLevel: 'warning',
      banner: { js: '// bundled by scripts/bundle_entrypoints.mjs — do not edit' },
    });
    renameSync(out, input);
    bundled += 1;
  }
  console.log(`[bundle-entrypoints] bundled ${bundled} entry point(s)`);
}

main().catch((error) => {
  console.error(`[bundle-entrypoints] ${error?.message || error}`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * CU-06: launcher for package scripts that run compiled `dist/` entries.
 *
 *   node scripts/run_built.mjs dist/scripts/run_doctor.js [args...]
 *
 * Imports the entry in-process (argv is rewritten so `isDirectScript()`
 * still sees the entry as the main module). Before `pnpm build`, a missing
 * dist/ module prints the shared "run `pnpm build` first" hint and exits 1
 * instead of a raw ERR_MODULE_NOT_FOUND stack. Any other import-time
 * failure is rendered through the same message + `next:` contract as the
 * script harness — stacks only appear when DEBUG is set.
 */
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatBuildRequiredMessage, isMissingBuildError } from './build_required_message.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [target, ...rest] = process.argv.slice(2);

if (!target || !target.endsWith('.js')) {
  console.error('Usage: node scripts/run_built.mjs <dist/...js> [args...]');
  process.exit(2);
}

const entry = resolve(ROOT, target);
process.argv = [process.argv[0], entry, ...rest];

const DEBUG = Boolean(process.env.DEBUG);

function printFallback(error) {
  console.error(`[${target}] ${error instanceof Error ? error.message : String(error)}`);
  if (DEBUG && error instanceof Error && error.stack) console.error(error.stack);
}

try {
  await import(pathToFileURL(entry).href);
} catch (error) {
  if (isMissingBuildError(error)) {
    console.error(formatBuildRequiredMessage(relative(ROOT, entry)));
    process.exit(1);
  }
  try {
    const { renderScriptError } = await import(
      pathToFileURL(resolve(ROOT, 'dist/libs/core/script-harness.js')).href
    );
    const report = renderScriptError(error, { debug: DEBUG });
    console.error(`[${target}] ${report.message}`);
    if (report.next) console.error(`  next: ${report.next}`);
    if (report.stack) console.error(report.stack);
  } catch {
    // The failure may be inside libs/core itself — degrade to a plain line.
    printFallback(error);
  }
  process.exit(1);
}

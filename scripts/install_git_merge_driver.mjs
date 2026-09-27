#!/usr/bin/env node
/**
 * GF-03: install / uninstall the optional "kyberion-regenerate" merge driver
 * used by .gitattributes for tracked generated files.
 *
 *   pnpm kyberion resolve install-driver              # one-time, repository owner
 *   pnpm kyberion resolve install-driver --uninstall
 *
 * Repo config is mission-owner territory (AGENTS.md §1): `pnpm install` never
 * runs this, and worker CLIs must not. The repo-local config is shared by
 * every linked worktree and by every agent CLI using this repository, so the
 * command prints exactly which `git config --local` keys it sets or removes.
 * Nothing depends on the driver: without it git uses its normal text merge
 * and `pnpm kyberion resolve generated` repairs the generated files.
 *
 * Bootstrap-class (no build, no @agent/core). Guards:
 * - no-op in CI (`CI` set), outside a git work tree (source archives), and
 *   when the package root is not the work-tree top (an archive extracted
 *   inside another checkout);
 * - idempotent: writes only when a key differs.
 * The driver command is a path relative to the worktree root (git runs merge
 * drivers there), so each worktree runs its own copy; a worktree on an older
 * branch without the script gets a normal conflict for those files.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DRIVER_NAME = 'kyberion-regenerate';
export const DRIVER_KEYS = {
  [`merge.${DRIVER_NAME}.name`]: 'Kyberion generated file (merge, else keep ours; then regenerate)',
  [`merge.${DRIVER_NAME}.driver`]: 'node scripts/git_merge_regenerate.mjs %O %A %B %P',
};

function git(args) {
  return execFileSync('git', ['-C', ROOT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function configured(key) {
  try {
    return git(['config', '--local', '--get', key]);
  } catch {
    return '';
  }
}

/** Returns a skip reason, or null when this checkout may be configured. */
function guard(env) {
  if (env.CI) return 'skipped:ci';
  try {
    if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return 'skipped:no-git';
    // An extracted source archive nested inside another checkout must not
    // configure that outer repository: only act when this package is the top.
    if (git(['rev-parse', '--show-prefix']) !== '') return 'skipped:nested';
  } catch {
    return 'skipped:no-git';
  }
  return null;
}

/**
 * @returns {{ status: string, changed: string[] }} `changed` lists the
 *   `git config --local` keys written (install) or removed (uninstall).
 */
export function installGitMergeDriver(env = process.env, options = {}) {
  const skipped = guard(env);
  if (skipped) return { status: skipped, changed: [] };
  const changed = [];
  if (options.uninstall) {
    for (const key of Object.keys(DRIVER_KEYS)) {
      if (!configured(key)) continue;
      git(['config', '--local', '--unset-all', key]);
      changed.push(key);
    }
    return { status: changed.length > 0 ? 'uninstalled' : 'unchanged', changed };
  }
  for (const [key, value] of Object.entries(DRIVER_KEYS)) {
    if (configured(key) === value) continue;
    git(['config', '--local', key, value]);
    changed.push(key);
  }
  return { status: changed.length > 0 ? 'installed' : 'unchanged', changed };
}

function main() {
  const uninstall = process.argv.includes('--uninstall');
  const result = installGitMergeDriver(process.env, { uninstall });
  const lines = [`[resolve install-driver] ${result.status}`];
  for (const key of result.changed) {
    lines.push(
      uninstall
        ? `  removed: git config --local --unset-all ${key}`
        : `  set:     git config --local ${key} "${DRIVER_KEYS[key]}"`
    );
  }
  if (result.status === 'unchanged') {
    lines.push(
      uninstall
        ? `  no merge.${DRIVER_NAME}.* keys were configured; nothing removed`
        : `  merge.${DRIVER_NAME}.* already configured; nothing written`
    );
  }
  console.log(lines.join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

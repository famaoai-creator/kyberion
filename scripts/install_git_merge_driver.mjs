#!/usr/bin/env node
/**
 * GF-03: register the repo-local "kyberion-regenerate" merge driver used by
 * .gitattributes for tracked generated files. Runs from `pnpm install`
 * (package.json `prepare`), so it is a bootstrap-class script: no build, no
 * @agent/core, and it must never fail an install.
 *
 * - No-op in CI (`CI` set) and outside a git work tree (source archives).
 * - Idempotent: only writes when the configured driver differs.
 * - `git config --local` lands in the common config shared by every linked
 *   worktree. The driver command is a path relative to the worktree root
 *   (git runs merge drivers there), so each worktree runs its own copy; a
 *   worktree on an older branch without the script just gets a normal
 *   conflict for those files.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DRIVER_NAME = 'kyberion-regenerate';
const DRIVER_COMMAND = 'node scripts/git_merge_regenerate.mjs %O %A %B %P';
const DRIVER_LABEL = 'Kyberion generated file (merge, else keep ours; then regenerate)';

function git(args) {
  return execFileSync('git', args, {
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

export function installGitMergeDriver(env = process.env) {
  if (env.CI) return 'skipped:ci';
  try {
    if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return 'skipped:no-git';
  } catch {
    return 'skipped:no-git';
  }
  const driverKey = `merge.${DRIVER_NAME}.driver`;
  if (configured(driverKey) === DRIVER_COMMAND) return 'unchanged';
  git(['config', '--local', `merge.${DRIVER_NAME}.name`, DRIVER_LABEL]);
  git(['config', '--local', driverKey, DRIVER_COMMAND]);
  return 'installed';
}

function main() {
  try {
    const result = installGitMergeDriver();
    if (result === 'installed') {
      console.log(`[install_git_merge_driver] configured merge.${DRIVER_NAME} (repo-local)`);
    }
  } catch (error) {
    // Never fail `pnpm install` over a convenience merge driver.
    console.warn(
      `[install_git_merge_driver] skipped: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

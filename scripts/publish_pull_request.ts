#!/usr/bin/env node
/**
 * Validate and open a pull request with a Conventional Commit title.
 *
 * This is a narrow wrapper around `gh pr create` that fails fast when the
 * requested PR title does not satisfy the repository's PR-title policy.
 */

import { safeExec, pathResolver } from '@agent/core';
import { checkTitle } from './check_pr_title.js';

interface PublishOptions {
  title?: string;
  bodyFile?: string;
  base?: string;
  draft: boolean;
  fill: boolean;
}

function readHeadSubject(): string {
  return safeExec('git', ['log', '-1', '--format=%s'], { cwd: pathResolver.rootDir() }).trim();
}

function readCurrentBranch(): string {
  return safeExec('git', ['branch', '--show-current'], { cwd: pathResolver.rootDir() }).trim();
}

function readDefaultBranch(): string {
  const raw = safeExec('gh', ['repo', 'view', '--json', 'defaultBranchRef'], {
    cwd: pathResolver.rootDir(),
  }).trim();
  const parsed = JSON.parse(raw);
  return parsed?.defaultBranchRef?.name || 'main';
}

export function parsePublishArgs(argv: string[]): PublishOptions {
  const options: PublishOptions = { draft: true, fill: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--title') options.title = argv[++i];
    else if (arg === '--body-file') options.bodyFile = argv[++i];
    else if (arg === '--base') options.base = argv[++i];
    else if (arg === '--no-draft') options.draft = false;
    else if (arg === '--no-fill') options.fill = false;
    else if (arg === '--draft') options.draft = true;
    else if (arg === '--fill') options.fill = true;
  }
  return options;
}

export function resolvePublishTitle(inputTitle?: string, headSubject?: string): string {
  const candidate = inputTitle?.trim() || headSubject?.trim() || readHeadSubject();
  const validation = checkTitle(candidate, inputTitle ? '--title' : 'HEAD commit subject');
  if (!validation.ok) {
    throw new Error(
      [
        `${validation.source} is not valid: ${validation.value}`,
        validation.reason || 'PR title must use a Conventional Commit header.',
        'Use a title like `fix(scope): summary` or pass `--title` explicitly.',
      ].join('\n'),
    );
  }
  return validation.value;
}

export function buildGhArgs(options: PublishOptions, context?: { head?: string; defaultBranch?: string }): string[] {
  const title = resolvePublishTitle(options.title, context?.head);
  const base = options.base?.trim() || context?.defaultBranch?.trim() || readDefaultBranch();
  const head = context?.head?.trim() || readCurrentBranch();
  if (!head) {
    throw new Error('Could not determine the current branch.');
  }

  const args = ['pr', 'create'];
  if (options.draft) args.push('--draft');
  if (options.fill && !options.bodyFile) args.push('--fill');
  args.push('--title', title, '--base', base, '--head', head);
  if (options.bodyFile) {
    args.push('--body-file', options.bodyFile);
  }
  return args;
}

async function main(): Promise<void> {
  const options = parsePublishArgs(process.argv.slice(2));

  safeExec('gh', ['--version'], { cwd: pathResolver.rootDir() });
  safeExec('gh', ['auth', 'status'], { cwd: pathResolver.rootDir() });

  const args = buildGhArgs(options);
  const output = safeExec('gh', args, { cwd: pathResolver.rootDir() });
  if (output.trim()) {
    console.log(output.trim());
  }
}

const isDirect = process.argv[1] && /publish_pull_request\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}

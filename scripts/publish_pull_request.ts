#!/usr/bin/env node
/**
 * Validate and open a pull request with a Conventional Commit title.
 *
 * This is a narrow wrapper around `gh pr create` that fails fast when the
 * requested PR title does not satisfy the repository's PR-title policy, and
 * (by default) runs the PR-scope readiness gate before create so agents and
 * operators follow knowledge/product/governance/pre-pr-ci-readiness-checklist.ja.md.
 */

import { pathResolver } from '@agent/core/path-resolver';
import { parseSafeJsonInput, parseSafeJsonObjectValue } from '@agent/core/foundation';
import { safeExec } from '@agent/core/secure-io';
import { checkTitle } from './check_pr_title.js';
import { defineScript, isDirectScript } from './lib/harness.js';

type Print = (value: unknown) => void;

export const PRE_PR_READINESS_CHECKLIST =
  'knowledge/product/governance/pre-pr-ci-readiness-checklist.ja.md';

interface PublishOptions {
  title?: string;
  bodyFile?: string;
  base?: string;
  draft: boolean;
  fill: boolean;
  skipReadiness: boolean;
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
  return parseDefaultBranchResponse(raw);
}

export function parseDefaultBranchResponse(raw: string): string {
  const parsed = parseSafeJsonObjectValue(
    parseSafeJsonInput(raw, 'gh repository response'),
    'gh repository response'
  );
  const ref = parsed.defaultBranchRef;
  const refRecord = ref && typeof ref === 'object' && !Array.isArray(ref) ? ref : null;
  return refRecord && typeof (refRecord as Record<string, unknown>).name === 'string'
    ? String((refRecord as Record<string, unknown>).name)
    : 'main';
}

export function parsePublishArgs(argv: string[]): PublishOptions {
  const options: PublishOptions = { draft: true, fill: true, skipReadiness: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--title') options.title = argv[++i];
    else if (arg === '--body-file') options.bodyFile = argv[++i];
    else if (arg === '--base') options.base = argv[++i];
    else if (arg === '--no-draft') options.draft = false;
    else if (arg === '--no-fill') options.fill = false;
    else if (arg === '--draft') options.draft = true;
    else if (arg === '--fill') options.fill = true;
    else if (arg === '--skip-readiness') options.skipReadiness = true;
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
      ].join('\n')
    );
  }
  return validation.value;
}

export function buildGhArgs(
  options: PublishOptions,
  context?: { head?: string; defaultBranch?: string }
): string[] {
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

export function runPrePrReadiness(print: Print = () => undefined): void {
  print(
    [
      '[pr:publish] Running PR readiness gate (pnpm check -- --scope pr).',
      `[pr:publish] Canonical checklist: ${PRE_PR_READINESS_CHECKLIST}`,
      '[pr:publish] Apply exception-table rows for actuator/env/core boundaries before create.',
      '[pr:publish] Pass --skip-readiness only for an explicit emergency bypass.',
    ].join('\n')
  );
  safeExec('pnpm', ['check', '--', '--scope', 'pr'], {
    cwd: pathResolver.rootDir(),
    timeoutMs: 1_800_000,
  });
  print('[pr:publish] PR readiness gate passed.');
}

async function main(argv: string[], print: Print = () => undefined): Promise<void> {
  const options = parsePublishArgs(argv);

  safeExec('gh', ['--version'], { cwd: pathResolver.rootDir() });
  safeExec('gh', ['auth', 'status'], { cwd: pathResolver.rootDir() });

  if (options.skipReadiness) {
    print(
      `[pr:publish] Skipping readiness gate (--skip-readiness). Still follow ${PRE_PR_READINESS_CHECKLIST}.`
    );
  } else {
    runPrePrReadiness(print);
  }

  const args = buildGhArgs(options);
  const output = safeExec('gh', args, { cwd: pathResolver.rootDir() });
  if (output.trim()) print(output.trim());
}

const script = defineScript({
  name: 'pr:publish',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});
if (
  isDirectScript(import.meta.url, 'publish_pull_request.ts') ||
  isDirectScript(import.meta.url, 'publish_pull_request.js')
) {
  void script();
}

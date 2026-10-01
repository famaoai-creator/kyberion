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
import { safeExec, safeReadFile } from '@agent/core/secure-io';
import { createLogger, formatDiagnostic } from '@agent/core/logger';
import {
  checkPrKnowledgeReadiness,
  GIT_REF_NAME_PATTERN,
} from '@agent/core/knowledge/pr-knowledge-readiness';
import { checkTitle } from './check_pr_title.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { guardCliArgs, type CliGuardSpec } from './lib/cli-guard.js';

type Print = (value: unknown) => void;

export const PRE_PR_READINESS_CHECKLIST =
  'knowledge/product/governance/pre-pr-ci-readiness-checklist.ja.md';

const KNOWLEDGE_IN_PR_PLAN =
  'docs/developer/improvement-plans-2026-09/KNOWLEDGE_IN_PR_PLAN_2026-09-30.ja.md';

const knowledgeLogger = createLogger('pr:publish');

interface PublishOptions {
  title?: string;
  bodyFile?: string;
  base?: string;
  draft: boolean;
  fill: boolean;
  skipReadiness: boolean;
  missionRoot?: string;
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

/** CU-01: every flag `parsePublishArgs` understands; anything else is rejected before gh runs. */
export const PUBLISH_PR_CLI: CliGuardSpec = {
  command: 'pnpm kyberion pr create',
  manifestId: 'script.pr.create',
  options: [
    { flag: '--title', value: '<conventional title>' },
    { flag: '--body-file', value: '<path>' },
    { flag: '--base', value: '<branch>' },
    { flag: '--mission-root', value: '<path>' },
    { flag: '--draft' },
    { flag: '--no-draft' },
    { flag: '--fill' },
    { flag: '--no-fill' },
    { flag: '--skip-readiness' },
  ],
};

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
    else if (arg === '--mission-root') options.missionRoot = argv[++i];
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

/**
 * KL-03 diff base for the knowledge readiness check (distinct from `gh pr
 * create --base`, which stays a bare branch name for gh itself, see
 * `buildGhArgs`): a branch name not already qualified (`origin/…`, `refs/…`) is mapped to `origin/<base>` so
 * the diff is always computed against the fetched remote-tracking ref rather
 * than a possibly-stale local branch of the same name; `--mission-root`-style
 * ref values are validated against `GIT_REF_NAME_PATTERN` (rejects a leading
 * `-`) so a crafted `--base` can never be read as a git option downstream.
 */
export function resolveKnowledgeDiffBase(base?: string): string {
  const trimmed = base?.trim();
  if (!trimmed) return 'origin/main';
  if (!GIT_REF_NAME_PATTERN.test(trimmed)) {
    throw new Error(
      `--base '${trimmed}' is not a valid git ref name (no leading '-', only [A-Za-z0-9._/-]).`
    );
  }
  return trimmed.startsWith('origin/') || trimmed.startsWith('refs/')
    ? trimmed
    : `origin/${trimmed}`;
}

/** `code` is a plain string here (not KnowledgeViolationCode) so the CLI-only `missing_body_file` case can share this printer. */
function logKnowledgeViolation(violation: { code: string; message: string }): void {
  knowledgeLogger.error(
    formatDiagnostic({
      component: 'pr:publish',
      what: `knowledge readiness: ${violation.code}`,
      why: violation.message,
      next: 'Resolve the mission memory candidates and/or the PR body, then re-run pr create.',
      evidence: KNOWLEDGE_IN_PR_PLAN,
    })
  );
}

/**
 * KL-03: local, blocking Knowledge-in-PR check. Runs after the (optionally
 * skipped) readiness gate and before `gh pr create` — `--skip-readiness`
 * never skips this, and there is no flag that does, because CI cannot see
 * `active/` mission records so this is the only place the check can run.
 */
export function runKnowledgeReadinessGate(options: PublishOptions): void {
  if (!options.bodyFile) {
    logKnowledgeViolation({
      code: 'missing_body_file',
      message:
        '`--fill` (or omitting --body-file) cannot carry a "## Knowledge" section — pass --body-file with a filled-in .github/PULL_REQUEST_TEMPLATE.md.',
    });
    throw new ScriptExitError(1, '', true);
  }
  const body = String(
    safeReadFile(options.bodyFile, { encoding: 'utf8', label: 'PR body file' }) || ''
  );
  const repoRoot = pathResolver.rootDir();
  const result = checkPrKnowledgeReadiness({
    body,
    repoRoot,
    missionRootInput: { explicitRoot: options.missionRoot, cwdRoot: repoRoot },
    base: resolveKnowledgeDiffBase(options.base),
  });
  if (!result.ok) {
    for (const violation of result.violations) logKnowledgeViolation(violation);
    throw new ScriptExitError(1, '', true);
  }
}

export async function main(argv: string[], print: Print = () => undefined): Promise<void> {
  // CU-01: `--help` and typos must never reach gh / the readiness gate.
  if (guardCliArgs(argv, PUBLISH_PR_CLI, print)) return;
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

  runKnowledgeReadinessGate(options);
  print('[pr:publish] Knowledge readiness check passed (KL-03).');

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

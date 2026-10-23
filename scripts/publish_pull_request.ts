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
import { getRegisteredEnvText } from '@agent/core/foundation/env';
import { createLogger, formatDiagnostic } from '@agent/core/logger';
import { ghMust } from '@agent/core/vcs';
import { computeApprovalPayloadHash } from '@agent/core/governance/approval-store';
import { withRuntimeExternalOperationAuthority } from '@agent/core/governance/external-operation-runtime';
import { publishWithWorktreeGovernance } from './lib/pr-worktree-governance.js';
import {
  checkPrKnowledgeReadiness,
  GIT_REF_NAME_PATTERN,
} from '@agent/core/knowledge/pr-knowledge-readiness';
import { checkTitle } from './check_pr_title.js';
import { parseCheckJobs } from './run_checks.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { guardCliArgsNormalized, type CliGuardSpec } from './lib/cli-guard.js';

type Print = (value: unknown) => void;

export const PRE_PR_READINESS_CHECKLIST =
  'knowledge/product/governance/pre-pr-ci-readiness-checklist.ja.md';

const KNOWLEDGE_IN_PR_PLAN =
  'docs/developer/improvement-plans-2026-09/KNOWLEDGE_IN_PR_PLAN_2026-09-30.ja.md';

const knowledgeLogger = createLogger('pr:publish');

interface PublishOptions {
  title?: string;
  body?: string;
  bodyFile?: string;
  base?: string;
  draft: boolean;
  fill: boolean;
  skipReadiness: boolean;
  missionRoot?: string;
  checkJobs?: number;
}

function readHeadSubject(): string {
  return safeExec('git', ['log', '-1', '--format=%s'], { cwd: pathResolver.rootDir() }).trim();
}

function readCurrentBranch(): string {
  return safeExec('git', ['branch', '--show-current'], { cwd: pathResolver.rootDir() }).trim();
}

/** Credentials are explicit overrides for gh only, never general child inheritance. */
function ghCredentialsEnv(): Record<string, string | undefined> {
  return {
    GH_TOKEN: getRegisteredEnvText('GH_TOKEN'),
    GITHUB_TOKEN: getRegisteredEnvText('GITHUB_TOKEN'),
  };
}

function ghOpts() {
  return { cwd: pathResolver.rootDir(), env: ghCredentialsEnv() };
}

function runGithubCli(args: string[]): string {
  return ghMust(args, ghOpts());
}

function readDefaultBranch(): string {
  const raw = runGithubCli(['repo', 'view', '--json', 'defaultBranchRef']).trim();
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
    { flag: '--body', value: '<markdown>' },
    { flag: '--body-file', value: '<path>' },
    { flag: '--base', value: '<branch>' },
    { flag: '--mission-root', value: '<path>' },
    { flag: '--check-jobs', value: '<1..6>' },
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
    else if (arg === '--body') options.body = argv[++i];
    else if (arg === '--body-file') options.bodyFile = argv[++i];
    else if (arg === '--base') options.base = argv[++i];
    else if (arg === '--no-draft') options.draft = false;
    else if (arg === '--no-fill') options.fill = false;
    else if (arg === '--draft') options.draft = true;
    else if (arg === '--fill') options.fill = true;
    else if (arg === '--skip-readiness') options.skipReadiness = true;
    else if (arg === '--mission-root') options.missionRoot = argv[++i];
    else if (arg === '--check-jobs') {
      if (options.checkJobs !== undefined)
        throw new Error('--check-jobs may only be specified once');
      const value = argv[++i];
      if (value === undefined) throw new Error('--check-jobs requires a value');
      options.checkJobs = parseCheckJobs(value, '--check-jobs');
    }
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

/**
 * S1/M1: the readiness gate runs `check --changed`, i.e. every pr gate plus
 * each full-only gate whose `paths` (ci-gates.json) match a file changed
 * since the merge-base — the subset of CI's `--scope full` this branch can
 * break. `base` is the PR base branch; a bare name diffs against `origin/<base>`.
 */
export function buildReadinessCheckArgs(checkJobs?: number, base?: string): string[] {
  const args = ['check', '--', '--changed'];
  if (base?.trim()) args.push('--base', resolveKnowledgeDiffBase(base));
  if (checkJobs !== undefined)
    args.push('--jobs', String(parseCheckJobs(String(checkJobs), '--check-jobs')));
  return args;
}

export function runPrePrReadiness(
  print: Print = () => undefined,
  checkJobs?: number,
  base?: string
): void {
  const args = buildReadinessCheckArgs(checkJobs, base);
  print(
    [
      `[pr:publish] Running PR readiness gate (pnpm ${args.join(' ')}).`,
      `[pr:publish] Canonical checklist: ${PRE_PR_READINESS_CHECKLIST}`,
      '[pr:publish] Full-only gates are selected by the changed paths (ci-gates.json `paths`); apply the remaining exception-table rows by hand.',
      '[pr:publish] Pass --skip-readiness only for an explicit emergency bypass.',
    ].join('\n')
  );
  safeExec('pnpm', args, {
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
  if (!options.bodyFile && options.body === undefined) {
    logKnowledgeViolation({
      code: 'missing_body_file',
      message:
        '`--fill` (or omitting --body/--body-file) cannot carry a "## Knowledge" section — pass --body-file with a filled-in .github/PULL_REQUEST_TEMPLATE.md, or --body with inline markdown.',
    });
    throw new ScriptExitError(1, '', true);
  }
  const body = options.bodyFile
    ? String(safeReadFile(options.bodyFile, { encoding: 'utf8', label: 'PR body file' }) || '')
    : (options.body ?? '');
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
  const guarded = guardCliArgsNormalized(argv, PUBLISH_PR_CLI, print);
  if (guarded.handled) return;
  const options = parsePublishArgs(guarded.argv);

  runGithubCli(['--version']);
  runGithubCli(['auth', 'status']);

  if (options.skipReadiness) {
    print(
      `[pr:publish] Skipping readiness gate (--skip-readiness). Still follow ${PRE_PR_READINESS_CHECKLIST}.`
    );
  } else {
    runPrePrReadiness(print, options.checkJobs, options.base);
  }

  runKnowledgeReadinessGate(options);
  print('[pr:publish] Knowledge readiness check passed (KL-03).');

  const args = buildGhArgs(options);
  // Keep the established title/ref resolution and explicit body-file contract,
  // but route publication through the typed, snapshot-bound approval boundary.
  const publication = {
    ...ghOpts(),
    title: args[args.indexOf('--title') + 1],
    base: args[args.indexOf('--base') + 1],
    head: args[args.indexOf('--head') + 1],
    body: options.body,
    bodyFile: options.bodyFile,
    draft: options.draft,
  };
  // The typed VCS boundary still verifies exact remote refs and content. This
  // identity is stable across resumption; changing text cannot reuse a receipt.
  const invocationId = computeApprovalPayloadHash({
    operation: 'vcs:pr_create',
    head: publication.head,
    base: publication.base,
    source: safeExec('git', ['rev-parse', '--verify', `${publication.head}^{commit}`], {
      cwd: pathResolver.rootDir(),
    }).trim(),
  });
  // Run inside the installed runtime authority context so an accountability
  // charter with an exact vcs:pr_create grant can delegate this publication;
  // without a matching grant the normal human approval path applies.
  const result = withRuntimeExternalOperationAuthority(
    { stepId: 'pr:publish', runId: invocationId },
    () => publishWithWorktreeGovernance(publication, invocationId, print)
  );
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.error?.message || 'GitHub PR creation failed');
  }
  const output = result.stdout;
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

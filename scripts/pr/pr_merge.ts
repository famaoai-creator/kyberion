#!/usr/bin/env node
/**
 * `pnpm kyberion pr merge <pr>` — merge an open pull request once its CI is
 * green, through the governed `vcs:pr_merge` operation.
 *
 * This is the merge half of `system:standard_pr_lifecycle` (`auto_merge`) for
 * a PR that already exists: wait until every check is terminal, refuse unless
 * they all passed, then merge the head commit they passed on
 * (`vcsHostPrMergeWhenGreen`). Authority is unchanged: the merge needs a human
 * approval (`pnpm kyberion approvals --approve <id>`, then rerun) unless the
 * operator's charter delegates `vcs:pr_merge` for the base branch.
 */
import { pathResolver } from '@agent/core/path-resolver';
import { withRuntimeExternalOperationAuthority } from '@agent/core/governance/external-operation-runtime';
import { vcsHostInvocationId, type VcsHostMutation } from '@agent/core/vcs/publication-host';
import { vcsHostPrMergeWhenGreen, type VcsHostPrMergeParams } from '@agent/core/vcs/vcs-host-verbs';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';
import { cliPositionals, guardCliArgsNormalized, type CliGuardSpec } from '../lib/cli/cli-guard.js';
import { runVcsMutationWithWorktreeGovernance } from '../lib/pr/pr-worktree-governance.js';

type Print = (value: unknown) => void;

/**
 * The merge step `pr create` uses for its publication: the VCS approval host
 * inside the installed runtime authority, so a charter grant for the base
 * branch delegates the merge and anything else opens a human decision (with
 * its review artifact) instead of failing headless.
 */
export function governedMergeStep(print: Print) {
  return async (params: VcsHostPrMergeParams): Promise<void> => {
    const {
      provider: _provider,
      hostProvider: _hostProvider,
      git: _git,
      ...rest
    } = params as VcsHostPrMergeParams & {
      provider?: unknown;
      hostProvider?: unknown;
      git?: unknown;
    };
    const mutation: VcsHostMutation = {
      operation: 'pr_merge',
      params: { ...rest, cwd: rest.cwd ?? pathResolver.rootDir() },
    };
    const invocationId = vcsHostInvocationId(mutation);
    const result = await withRuntimeExternalOperationAuthority(
      { stepId: 'pr:merge', runId: invocationId },
      () => runVcsMutationWithWorktreeGovernance(mutation, invocationId, print)
    );
    if (result.error || result.status !== 0)
      throw new Error(result.stderr?.trim() || result.error?.message || 'pr merge failed');
  };
}

export const MERGE_PR_CLI: CliGuardSpec = {
  command: 'pnpm kyberion pr merge',
  manifestId: 'script.pr.merge',
  positional: '<pr number or url>',
  options: [
    { flag: '--checks-timeout-minutes', value: '<1..180>' },
    { flag: '--method', value: '<merge|squash|rebase>' },
  ],
};

const VALUE_FLAGS = ['--checks-timeout-minutes', '--method'];
const METHODS = ['merge', 'squash', 'rebase'] as const;
type Method = (typeof METHODS)[number];

export interface MergeOptions {
  ref: string;
  checksTimeoutMinutes: number;
  method: Method;
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parseMergeArgs(argv: readonly string[]): MergeOptions {
  const positionals = cliPositionals(argv, VALUE_FLAGS);
  if (positionals.length !== 1)
    throw new ScriptExitError(2, 'pr merge needs exactly one PR number or URL');
  const ref = positionals[0] as string;
  if (!/^([1-9]\d*|https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/[1-9]\d*)$/u.test(ref))
    throw new ScriptExitError(
      2,
      `not a PR number or URL: ${ref} (expected 123 or https://github.com/<owner>/<repo>/pull/123)`
    );
  const rawTimeout = flagValue(argv, '--checks-timeout-minutes') ?? '30';
  const checksTimeoutMinutes = Number(rawTimeout);
  if (
    !Number.isInteger(checksTimeoutMinutes) ||
    checksTimeoutMinutes < 1 ||
    checksTimeoutMinutes > 180
  )
    throw new ScriptExitError(2, '--checks-timeout-minutes must be an integer from 1 to 180');
  const method = (flagValue(argv, '--method') ?? 'merge') as Method;
  if (!METHODS.includes(method))
    throw new ScriptExitError(2, `--method must be one of ${METHODS.join(', ')}`);
  return { ref, checksTimeoutMinutes, method };
}

export async function main(
  argv: string[],
  print: Print = () => undefined,
  merge: typeof vcsHostPrMergeWhenGreen = vcsHostPrMergeWhenGreen
): Promise<void> {
  const guarded = guardCliArgsNormalized(argv, MERGE_PR_CLI, print);
  if (guarded.handled) return;
  const options = parseMergeArgs(guarded.argv);
  print(
    `[pr:merge] Waiting up to ${options.checksTimeoutMinutes} min for checks on ${options.ref}…`
  );
  let result: Awaited<ReturnType<typeof vcsHostPrMergeWhenGreen>>;
  try {
    result = await merge({
      cwd: pathResolver.rootDir(),
      ref: options.ref,
      method: options.method,
      deleteBranch: true,
      checksTimeoutMs: options.checksTimeoutMinutes * 60_000,
      mergeStep: governedMergeStep(print),
    });
  } catch (error) {
    throw new Error(approvalHint(error, options.ref) ?? errorText(error));
  }
  print(
    `[pr:merge] Merged #${result.number} at ${result.headSha.slice(0, 10)} and deleted its branch (waited ${formatDuration(result.waited_ms)} for checks).`
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const APPROVAL_ID = /\| approval: (\S+)/u;

/** The merge gate asked for a human decision: name the command that decides it. */
export function approvalHint(error: unknown, ref: string): string | undefined {
  const message = errorText(error);
  if (!message.startsWith('[EXTERNAL_APPROVAL_REQUIRED]')) return undefined;
  const id = message.match(APPROVAL_ID)?.[1];
  // The script harness prefixes "[pr:merge]" itself.
  if (!id)
    return (
      `PR ${ref} not merged — checks passed, but the merge gate opened no approval request` +
      ` (${message.replace('[EXTERNAL_APPROVAL_REQUIRED] ', '')})` +
      ` | next: run pnpm kyberion pr merge ${ref} from a human terminal, or delegate vcs:pr_merge for the base branch in your charter`
    );
  return (
    `PR ${ref} not merged yet — checks passed and the merge needs your approval` +
    ` | next: pnpm kyberion approvals --approve ${id}, then rerun pnpm kyberion pr merge ${ref}` +
    ' | evidence: a charter that delegates vcs:pr_merge for the base branch skips this step'
  );
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

const script = defineScript({
  name: 'pr:merge',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});
if (
  isDirectScript(import.meta.url, 'pr_merge.ts') ||
  isDirectScript(import.meta.url, 'pr_merge.js')
) {
  void script();
}

import { safeExec, safeExecResult, type SafeExecOptions } from '../secure-io.js';
import { assertNotFlagLike, type VcsCommandResult, type VcsCommandRunner } from './git.js';

/**
 * Typed GitHub CLI (`gh`) operations over the governed exec boundary — the
 * single implementation behind `vcs-actuator`'s PR ops and the scripts that
 * used to embed `gh …` argv directly (publish_pull_request, pr_shadow,
 * system-actuator's PR lifecycle).
 *
 * Wait/retry semantics (e.g. `ghPrChecksWait`) live here — per the layered
 * execution plan, polling belongs inside the op, not in pipeline transforms.
 */

export interface GhCallOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export function ghRun(
  args: string[],
  options: GhCallOptions = {},
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  const execOptions: SafeExecOptions = {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  };
  return run('gh', args, execOptions);
}

export function ghMust(
  args: string[],
  options: GhCallOptions = {},
  run?: VcsCommandRunner
): string {
  if (run) {
    const result = ghRun(args, options, run);
    if (result.error || result.status !== 0) {
      throw new Error(
        `[VCS_GH_FAILED] gh ${args.slice(0, 2).join(' ')}: ${result.stderr || result.error?.message || `exit ${result.status}`}`
      );
    }
    return result.stdout;
  }
  // Default path uses the throwing safeExec — the seam existing callers and
  // their tests already intercept (publish_pull_request's credential checks).
  try {
    return safeExec('gh', args, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[VCS_GH_FAILED] gh ${args.slice(0, 2).join(' ')}: ${message}`);
  }
}

function parseJsonStdout<T>(stdout: string, label: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw new Error(
      `[VCS_GH_INVALID_JSON] ${label}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function ghVersion(
  options: GhCallOptions = {},
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  return ghRun(['--version'], options, run);
}

export function ghAuthStatus(
  options: GhCallOptions = {},
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  return ghRun(['auth', 'status'], options, run);
}

export function ghRepoDefaultBranch(
  options: GhCallOptions = {},
  run: VcsCommandRunner = safeExecResult
): string {
  const raw = ghMust(['repo', 'view', '--json', 'defaultBranchRef'], options, run);
  const parsed = parseJsonStdout<{ defaultBranchRef?: { name?: string } }>(raw, 'gh repo view');
  const name = parsed.defaultBranchRef?.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('[VCS_GH_INVALID_JSON] gh repo view: defaultBranchRef.name missing');
  }
  return name;
}

export interface PrViewParams extends GhCallOptions {
  /** PR number, URL, or branch name. */
  ref: string;
  /** gh field list, e.g. 'state,mergedAt,closedAt' or 'files'. */
  fields: string;
}

export function ghPrView(params: PrViewParams, run?: VcsCommandRunner): Record<string, unknown> {
  assertNotFlagLike(params.ref, 'pr ref');
  const stdout = ghMust(['pr', 'view', params.ref, '--json', params.fields], params, run);
  return parseJsonStdout<Record<string, unknown>>(stdout, `gh pr view ${params.ref}`);
}

export interface PrListEntry {
  number: number;
  title: string;
  headRefOid?: string;
  headRefName?: string;
  isDraft?: boolean;
  author?: { login?: string };
  state?: string;
}

export function ghPrList(
  params: { state?: 'open' | 'closed' | 'merged' | 'all'; limit?: number } & GhCallOptions = {},
  run: VcsCommandRunner = safeExecResult
): PrListEntry[] {
  const stdout = ghMust(
    [
      'pr',
      'list',
      '--state',
      params.state || 'open',
      '--limit',
      String(params.limit || 100),
      '--json',
      'number,title,headRefOid,headRefName,isDraft,author,state',
    ],
    params,
    run
  );
  return parseJsonStdout<PrListEntry[]>(stdout, 'gh pr list');
}

export interface PrCheckEntry {
  name: string;
  state?: string;
  bucket?: string;
  link?: string;
}

export type PrChecksVerdict = 'success' | 'failure' | 'pending' | 'none';

export interface PrChecksResult {
  state: PrChecksVerdict;
  checks: PrCheckEntry[];
  failing: string[];
  pending: string[];
}

/**
 * `gh pr checks --json name,state,bucket,link`. `gh` exits non-zero while any
 * check is pending or failed — the JSON payload is still valid, so callers get
 * the parsed state regardless of exit status.
 */
export function ghPrChecks(
  params: { ref: string; ignore?: string[] } & GhCallOptions,
  run: VcsCommandRunner = safeExecResult
): PrChecksResult {
  assertNotFlagLike(params.ref, 'pr ref');
  const result = ghRun(
    ['pr', 'checks', params.ref, '--json', 'name,state,bucket,link'],
    params,
    run
  );
  const raw = (result.stdout || '').trim();
  if (!raw) {
    if (result.error || (result.status ?? 0) !== 0) {
      throw new Error(
        `[VCS_GH_FAILED] gh pr checks ${params.ref}: ${result.stderr || result.error?.message || `exit ${result.status}`}`
      );
    }
    return { state: 'none', checks: [], failing: [], pending: [] };
  }
  const all = parseJsonStdout<PrCheckEntry[]>(raw, `gh pr checks ${params.ref}`);
  const ignored = new Set(params.ignore || []);
  const checks = all.filter((check) => !ignored.has(check.name));
  if (!checks.length) return { state: 'none', checks, failing: [], pending: [] };
  const failing = checks
    .filter((check) => check.bucket === 'fail' || check.bucket === 'cancel')
    .map((check) => check.name);
  const pending = checks.filter((check) => check.bucket === 'pending').map((check) => check.name);
  return {
    state: failing.length ? 'failure' : pending.length ? 'pending' : 'success',
    checks,
    failing,
    pending,
  };
}

export interface PrChecksWaitResult extends PrChecksResult {
  waited_ms: number;
  timed_out: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The `gh pr checks --watch` equivalent as a governed op: poll until every
 * check reaches a terminal bucket, or `timeoutMs` elapses (fail-closed with
 * the last observed state). `sleep` is injectable for deterministic tests.
 */
export async function ghPrChecksWait(
  params: {
    ref: string;
    intervalMs?: number;
    timeoutMs?: number;
    ignore?: string[];
  } & GhCallOptions,
  run: VcsCommandRunner = safeExecResult,
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<PrChecksWaitResult> {
  const intervalMs = Math.max(1000, params.intervalMs ?? 15_000);
  const timeoutMs = params.timeoutMs ?? 20 * 60_000;
  const started = Date.now();
  // 'none' (no checks reported yet) is NOT terminal — `gh pr checks` can
  // return an empty payload for a while right after `pr create`.
  // Per-call exec timeout stays bounded so a hung gh can't eat the budget;
  // a few consecutive transient failures are tolerated before aborting.
  const perCallTimeoutMs = Math.min(60_000, timeoutMs);
  const maxConsecutiveErrors = 3;
  let consecutiveErrors = 0;
  let last: PrChecksResult = { state: 'none', checks: [], failing: [], pending: [] };
  let lastError: string | undefined;
  for (;;) {
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) break;
    try {
      last = ghPrChecks(
        { ...params, timeoutMs: Math.min(perCallTimeoutMs, Math.max(1000, timeoutMs - elapsed)) },
        run
      );
      consecutiveErrors = 0;
      lastError = undefined;
    } catch (error) {
      consecutiveErrors += 1;
      lastError = error instanceof Error ? error.message : String(error);
      if (consecutiveErrors >= maxConsecutiveErrors) {
        throw new Error(`[VCS_GH_WAIT_FAILED] gh pr checks ${params.ref}: ${lastError}`);
      }
    }
    if (last.state !== 'pending' && last.state !== 'none') break;
    await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - (Date.now() - started))));
  }
  const timedOut =
    (last.state === 'pending' || last.state === 'none') && Date.now() - started >= timeoutMs;
  return { ...last, waited_ms: Date.now() - started, timed_out: timedOut };
}

export function ghPrMerge(
  params: {
    ref: string;
    method?: 'merge' | 'squash' | 'rebase';
    deleteBranch?: boolean;
  } & GhCallOptions,
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  assertNotFlagLike(params.ref, 'pr ref');
  const args = ['pr', 'merge', params.ref, `--${params.method || 'merge'}`];
  if (params.deleteBranch !== false) args.push('--delete-branch');
  return ghRun(args, params, run);
}

export function ghPrCreate(
  params: {
    title: string;
    body?: string;
    bodyFile?: string;
    base?: string;
    head?: string;
    draft?: boolean;
  } & GhCallOptions,
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  if (!params.title?.trim()) throw new Error('[VCS_GH_INVALID] pr create requires a title');
  if (params.head !== undefined) assertNotFlagLike(params.head, 'head');
  if (params.base !== undefined) assertNotFlagLike(params.base, 'base');
  const args = ['pr', 'create', '--title', params.title.trim()];
  if (params.bodyFile) args.push('--body-file', params.bodyFile);
  else if (params.body?.trim()) args.push('--body', params.body.trim());
  if (params.base?.trim()) args.push('--base', params.base.trim());
  if (params.head?.trim()) args.push('--head', params.head.trim());
  if (params.draft) args.push('--draft');
  return ghRun(args, params, run);
}

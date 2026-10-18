import { safeExec, safeExecResult, type SafeExecOptions } from '../secure-io.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { assertNotFlagLike, type VcsCommandResult, type VcsCommandRunner } from './git.js';
import { redactActiveSecretsForHostLog } from '../secret/secret-guard.js';

export interface GhDiagnostic {
  status:
    | 'ready'
    | 'cli_missing'
    | 'dns_failure'
    | 'network_failure'
    | 'credential_unavailable'
    | 'credential_rejected'
    | 'credential_missing'
    | 'credential_unverified'
    | 'missing_resource'
    | 'permission_denied'
    | 'invalid_arguments'
    | 'command_failure';
  next: string;
  /** A shell probe cannot establish the state of a separately authenticated connector. */
  connector_status: 'not_probed';
}

/** Never publish raw gh auth output: it can include credentials, including unknown formats. */
export function sanitizeGhOutput(value: string): string {
  let sanitized = redactActiveSecretsForHostLog(value);
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN'] as const) {
    const token = getRegisteredEnvText(name);
    if (token) sanitized = sanitized.split(token).join('[REDACTED]');
  }
  return sanitized
    .replace(/github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/((?:token|authorization|password)\s*[:=]\s*)([^\r\n]+)/gi, '$1[REDACTED]');
}

/** Classify evidence, not the auth command's potentially misleading summary. */
export function diagnoseGhResult(
  result: VcsCommandResult,
  context: { authProbe?: boolean } = {}
): GhDiagnostic {
  const message = `${result.stderr || ''}\n${result.stdout || ''}\n${result.error?.message || ''}`;
  let status: GhDiagnostic['status'];
  let next: string;
  if (!result.error && result.status === 0) {
    status = 'ready';
    next = 'Continue with the GitHub CLI.';
  } else if (
    (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ||
    /command not found|executable file not found|spawn gh ENOENT/i.test(message)
  ) {
    status = 'cli_missing';
    next = 'Install the GitHub CLI and verify it is on PATH.';
  } else if (
    /ENOTFOUND|EAI_AGAIN|getaddrinfo|no such host|could not resolve host|temporary failure in name resolution/i.test(
      message
    )
  ) {
    status = 'dns_failure';
    next =
      'Check DNS from this runtime and compare with a normal host terminal before changing authentication.';
  } else if (
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|network is unreachable|connection refused|TLS handshake|i\/o timeout|error connecting to/i.test(
      message
    )
  ) {
    status = 'network_failure';
    next = 'Check network access from this runtime before changing authentication.';
  } else if (
    /keychain|keyring|credential store|securityd|getpwuid|failed to (?:read|retrieve|access).*credential/i.test(
      message
    )
  ) {
    status = 'credential_unavailable';
    next =
      'Compare credential-store access with a normal host terminal; restore runtime OS access before resetting authentication.';
  } else if (/\bHTTP\s+401\b|\b401\s+Unauthorized\b|\bBad credentials\b/i.test(message)) {
    status = 'credential_rejected';
    next =
      'GitHub rejected the credential; review the CLI authentication in a normal host terminal.';
  } else if (/not logged (?:in|into)|not authenticated/i.test(message)) {
    status = 'credential_missing';
    next =
      'Check runtime credential-store access and compare with a normal host terminal before signing in.';
  } else if (
    /\bHTTP\s+403\b|permission denied|resource not accessible|insufficient (?:permission|scope)|not authorized|forbidden/i.test(
      message
    )
  ) {
    status = 'permission_denied';
    next = 'Review repository access and the permissions required by this GitHub operation.';
  } else if (
    /\bHTTP\s+404\b|no pull requests? found|could not resolve to (?:a|an)|repository not found|could not find (?:pull request|repository)|not found in repository/i.test(
      message
    )
  ) {
    status = 'missing_resource';
    next =
      'Check the repository and resource reference, and whether the current identity can access it.';
  } else if (
    /unknown (?:flag|command)|invalid (?:argument|flag|value)|accepts? \d+ arg|requires? (?:an? |at least )?argument|flag needs an argument/i.test(
      message
    )
  ) {
    status = 'invalid_arguments';
    next = 'Check the arguments supported by this GitHub CLI operation.';
  } else if (context.authProbe || hasUnverifiedCredentialEvidence(message)) {
    status = 'credential_unverified';
    next =
      'Credential validity is unverified; compare DNS and OS credential access with a normal host terminal before resetting authentication.';
  } else {
    status = 'command_failure';
    next =
      'Review this operation in a normal host terminal; the failure does not establish an authentication or network problem.';
  }
  return { status, next, connector_status: 'not_probed' };
}

function hasUnverifiedCredentialEvidence(message: string): boolean {
  // A fixed number of literal scans per line keeps repeated token/invalid
  // prefixes linear, unlike an unanchored marker.*marker regex.
  return message
    .toLowerCase()
    .split(/[\r\n\u2028\u2029]/)
    .some((line) => {
      const ordered = (starts: string[], ends: string[]): boolean =>
        starts.some((start) => {
          const index = line.indexOf(start);
          return index >= 0 && ends.some((end) => line.indexOf(end, index + start.length) >= 0);
        });
      return (
        ordered(['token', 'credential', 'authentication'], ['invalid', 'failed', 'unverified']) ||
        ordered(['invalid'], ['token', 'credential'])
      );
    });
}

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

function ghExecOptions(options: GhCallOptions): SafeExecOptions {
  const registeredTokens = {
    GH_TOKEN: getRegisteredEnvText('GH_TOKEN'),
    GITHUB_TOKEN: getRegisteredEnvText('GITHUB_TOKEN'),
  };
  const env = {
    ...Object.fromEntries(Object.entries(registeredTokens).filter(([, v]) => v)),
    ...(options.env || {}),
  };
  return { ...options, ...(Object.keys(env).length > 0 ? { env } : {}) };
}

export function ghRun(
  args: string[],
  options: GhCallOptions = {},
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  // GH_TOKEN/GITHUB_TOKEN are excluded from the ambient exec allowlist, so
  // attach the *registered* values explicitly — the same explicit-override
  // channel publish_pull_request/pr_shadow use. Without this, the gh ops
  // only work where keyring auth exists (a GH_TOKEN-only CI env fails).
  return run('gh', args, ghExecOptions(options));
}

export function ghMust(
  args: string[],
  options: GhCallOptions = {},
  run?: VcsCommandRunner
): string {
  const authProbe = args[0] === 'auth' && args[1] === 'status';
  // Only fixed operation names are safe in errors; resource refs and flags may contain secrets.
  const knownOperations = new Set([
    'auth status',
    'pr view',
    'pr list',
    'pr checks',
    'pr create',
    'pr merge',
    'repo view',
  ]);
  const candidate = `${args[0]} ${args[1]}`;
  const operation = knownOperations.has(candidate)
    ? `gh ${candidate}`
    : args[0] === '--version'
      ? 'gh --version'
      : 'gh command';
  if (run) {
    const result = ghRun(args, options, run);
    if (result.error || result.status !== 0) {
      const diagnostic = diagnoseGhResult(result, { authProbe });
      throw new Error(`[VCS_GH_FAILED] ${operation}: ${diagnostic.status}: ${diagnostic.next}`);
    }
    return result.stdout;
  }
  // Default path uses the throwing safeExec — the seam existing callers and
  // their tests already intercept (publish_pull_request's credential checks).
  try {
    return safeExec('gh', args, ghExecOptions(options));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = diagnoseGhResult(
      {
        status: 1,
        stdout: '',
        stderr: message,
        error: error instanceof Error ? error : undefined,
      },
      { authProbe }
    );
    throw new Error(`[VCS_GH_FAILED] ${operation}: ${diagnostic.status}: ${diagnostic.next}`);
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

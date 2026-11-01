import {
  safeExec,
  safeExecResult,
  safeReadFile,
  assertSafeRepositoryPath,
  type SafeExecOptions,
} from '../secure-io.js';
import { toRepoRelative } from '../path-resolver.js';
import { classifyStorageFloorPath } from '../storage-layout.js';
import { isValidTenantSlug } from '../entity-scope.js';
import { isTenantOwnedPolicyPath } from '../tier-guard.js';
import { governVcsCommand } from './external-vcs.js';
import { computeApprovalPayloadHash } from '../governance/approval-store.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { assertNotFlagLike, type VcsCommandResult, type VcsCommandRunner } from './git.js';
import { redactActiveSecretsForHostLog } from '../secret/secret-guard.js';
import { AsyncLocalStorage } from 'node:async_hooks';

export type PrBodySourceTier =
  | 'public'
  | 'protected_or_unknown'
  | 'inline'
  | { tier: 'personal' }
  | { tier: 'confidential'; tenantSlug: string };
const publicationBodySource = new AsyncLocalStorage<PrBodySourceTier>();

/** Classify only provable canonical sources. Arbitrary repo files are not public evidence. */
export function prPublicationBodySourceForPath(bodyFile: string | undefined): PrBodySourceTier {
  if (!bodyFile) return 'inline';
  const relative = toRepoRelative(assertSafeRepositoryPath(bodyFile)).replace(/\\/gu, '/');
  if (relative.startsWith('knowledge/public/')) return 'public';
  if (relative.startsWith('knowledge/personal/')) return { tier: 'personal' };
  const confidential = relative.match(/^knowledge\/confidential\/([^/]+)\/.+/u);
  if (confidential && isTenantOwnedPolicyPath(relative, confidential[1]))
    return { tier: 'confidential', tenantSlug: confidential[1] };
  const partition = classifyStorageFloorPath(relative)?.partition;
  if (partition?.kind !== 'tier') return 'protected_or_unknown';
  if (partition.tier === 'public' && !partition.tenant) return 'public';
  if (partition.tier === 'personal' && !partition.tenant) return { tier: 'personal' };
  if (
    partition.tier === 'confidential' &&
    partition.tenant &&
    isTenantOwnedPolicyPath(relative, partition.tenant)
  )
    return { tier: 'confidential', tenantSlug: partition.tenant };
  return 'protected_or_unknown';
}

/** Trusted worktree host preserves the provenance of a frozen inline body.
 * Moving bytes over stdin must never turn a protected file into public text. */
export function withPrPublicationBodySource<T>(tier: PrBodySourceTier, action: () => T): T {
  const valid =
    typeof tier === 'string'
      ? ['public', 'inline', 'protected_or_unknown'].includes(tier)
      : tier &&
        ((tier.tier === 'personal' && Object.keys(tier).length === 1) ||
          (tier.tier === 'confidential' &&
            Object.keys(tier).length === 2 &&
            isValidTenantSlug(tier.tenantSlug)));
  if (!valid)
    throw new Error('[PR_BODY_PROVENANCE_INVALID] Trusted source classification required');
  return publicationBodySource.run(
    typeof tier === 'object' ? Object.freeze({ ...tier }) : tier,
    action
  );
}

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
  assertGhRead(args);
  return governVcsCommand(
    'vcs:github:read',
    { args, cwd: options.cwd },
    () => run('gh', args, ghExecOptions(options)),
    false
  );
}

const PR_QUEUE_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){mergeQueueEntry{id}}}}';
export function ghPrQueued(
  params: GhCallOptions & { owner: string; name: string; number: number; hostname: string },
  run?: VcsCommandRunner
): boolean {
  const row = JSON.parse(
    ghMust(
      [
        'api',
        'graphql',
        '--hostname',
        params.hostname,
        '-f',
        `query=${PR_QUEUE_QUERY}`,
        '-f',
        `owner=${params.owner}`,
        '-f',
        `name=${params.name}`,
        '-F',
        `number=${params.number}`,
      ],
      params,
      run
    )
  ) as { errors?: unknown; data?: { repository?: { pullRequest?: { mergeQueueEntry: unknown } } } };
  if (row.errors || !row.data?.repository?.pullRequest)
    throw new Error('[VCS_QUEUE_UNVERIFIED] Cannot verify server merge queue');
  return Boolean(row.data.repository.pullRequest.mergeQueueEntry);
}
function assertGhRead(args: string[]): void {
  if (
    args.length === 12 &&
    args[0] === 'api' &&
    args[1] === 'graphql' &&
    args[2] === '--hostname' &&
    args[4] === '-f' &&
    args[5] === `query=${PR_QUEUE_QUERY}` &&
    args[6] === '-f' &&
    /^owner=[\w.-]+$/.test(args[7]) &&
    args[8] === '-f' &&
    /^name=[\w.-]+$/.test(args[9]) &&
    args[10] === '-F' &&
    /^number=[1-9][0-9]*$/.test(args[11])
  )
    return;

  if (
    args[0] === '--version' ||
    ['auth status', 'pr view', 'pr list', 'pr checks', 'repo view'].includes(
      `${args[0]} ${args[1]}`
    )
  )
    return;
  if (
    args[0] === 'api' &&
    args.length === 4 &&
    args[2] === '--hostname' &&
    (/^repos\/[\w.-]+\/[\w.-]+\/commits\/[^\s]+$/.test(args[1]) ||
      /^repos\/[\w.-]+\/[\w.-]+$/.test(args[1]) ||
      /^repos\/[\w.-]+\/[\w.-]+\/git\/trees\/[a-f0-9]{40,64}$/.test(args[1]) ||
      /^repos\/[\w.-]+\/[\w.-]+\/branches\/[^\s/?]+\/protection\/required_status_checks$/.test(
        args[1]
      ) ||
      /^repos\/[\w.-]+\/[\w.-]+\/rules\/branches\/[^\s/?]+$/.test(args[1]) ||
      /^repos\/[\w.-]+\/[\w.-]+\/commits\/[a-f0-9]{40,64}\/check-runs\?per_page=100&filter=latest$/.test(
        args[1]
      ) ||
      /^repos\/[\w.-]+\/[\w.-]+\/actions\/runs\?head_sha=[a-f0-9]{40,64}&per_page=100$/.test(
        args[1]
      ) ||
      /^repos\/[\w.-]+\/[\w.-]+\/contents\/\.github\/workflows\/[^\s/?]+\?ref=[a-f0-9]{40,64}$/.test(
        args[1]
      ))
  )
    return;
  throw new Error(
    '[VCS_TYPED_VERB_REQUIRED] Use a typed mutation verb with a bound publication snapshot'
  );
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
    assertGhRead(args);
    return governVcsCommand(
      'vcs:github:read',
      { args, cwd: options.cwd },
      () => ({
        status: 0,
        stdout: safeExec('gh', args, ghExecOptions(options)),
        stderr: '',
      }),
      false
    ).stdout;
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
    /** Narrows the already governed merge to independently reviewed commits. */
    expectedHeadSha?: string;
    expectedBaseSha?: string;
  } & GhCallOptions,
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  assertNotFlagLike(params.ref, 'pr ref');
  const repository = ghPrRepository(params, run);
  const snapshot = () =>
    ghJsonSnapshot(
      [
        'pr',
        'view',
        params.ref,
        '--repo',
        repository.url,
        '--json',
        'number,url,headRefOid,baseRefOid,baseRefName,headRefName',
      ],
      params,
      run
    );
  const bound = snapshot();
  if (
    (params.expectedHeadSha !== undefined && params.expectedHeadSha !== bound.headRefOid) ||
    (params.expectedBaseSha !== undefined && params.expectedBaseSha !== bound.baseRefOid)
  )
    throw new Error('[VCS_REVIEW_STALE] PR differs from the verified promotion revision');
  if (!Number.isInteger(bound.number) || !/^[a-f0-9]{40,64}$/i.test(String(bound.headRefOid)))
    throw new Error('[VCS_SNAPSHOT_UNAVAILABLE] PR identity and head commit required');
  if (bound.url !== `${repository.url.replace(/\/$/, '')}/pull/${bound.number}`) {
    throw new Error('[VCS_SNAPSHOT_UNAVAILABLE] PR belongs to a different repository');
  }
  const args = [
    'pr',
    'merge',
    String(bound.number),
    '--repo',
    repository.url,
    `--${params.method || 'merge'}`,
    '--match-head-commit',
    String(bound.headRefOid),
  ];
  if (params.deleteBranch !== false) args.push('--delete-branch');
  return governVcsCommand(
    'vcs:pr_merge',
    {
      repository,
      repository_visibility: ghRepositoryVisibility({ ...params, repository }, run),
      ...bound,
      method: params.method || 'merge',
      deleteBranch: params.deleteBranch !== false,
    },
    () => {
      if (computeApprovalPayloadHash(snapshot()) !== computeApprovalPayloadHash(bound))
        throw new Error('[VCS_SNAPSHOT_CHANGED] PR changed before merge');
      return run('gh', args, ghExecOptions(params));
    },
    true
  );
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
  const repository = ghPrRepository(params, run);
  const localRead = (args: string[]) => {
    const result = run('git', args, { cwd: params.cwd });
    if (result.error || result.status !== 0 || !result.stdout.trim())
      throw new Error('[VCS_SNAPSHOT_UNAVAILABLE] Cannot resolve PR source');
    return result.stdout.trim();
  };
  const head = params.head?.trim() || localRead(['symbolic-ref', '--short', 'HEAD']);
  const base = params.base?.trim() || ghRepoDefaultBranch(params, run);
  assertNotFlagLike(head, 'head');
  assertNotFlagLike(base, 'base');
  const body = params.bodyFile
    ? String(safeReadFile(params.bodyFile, { encoding: 'utf8' }))
    : publicationBodySource.getStore()
      ? (params.body ?? '')
      : params.body?.trim() || '';
  const bodyProvenance = params.bodyFile
    ? prPublicationBodySourceForPath(params.bodyFile)
    : (publicationBodySource.getStore() ?? 'inline');
  const bodySourceTier = typeof bodyProvenance === 'object' ? bodyProvenance.tier : bodyProvenance;
  const snapshot = () => ({
    head,
    base,
    headSha: localRead(['rev-parse', '--verify', `${head}^{commit}`]),
    remoteHead: ghJsonSnapshot(
      [
        'api',
        `repos/${repository.slug}/commits/${encodeURIComponent(head)}`,
        '--hostname',
        repository.host,
      ],
      params,
      run
    ).sha,
    remoteBase: ghJsonSnapshot(
      [
        'api',
        `repos/${repository.slug}/commits/${encodeURIComponent(base)}`,
        '--hostname',
        repository.host,
      ],
      params,
      run
    ).sha,
  });
  const bound = snapshot();
  if (
    !/^[a-f0-9]{40,64}$/i.test(bound.headSha) ||
    bound.remoteHead !== bound.headSha ||
    !/^[a-f0-9]{40,64}$/i.test(String(bound.remoteBase))
  )
    throw new Error(
      '[VCS_SNAPSHOT_UNAVAILABLE] Push the exact PR source commit before creating a PR'
    );
  const args = [
    'pr',
    'create',
    '--repo',
    repository.url,
    '--title',
    params.title.trim(),
    '--body',
    body,
    '--base',
    base,
    '--head',
    head,
  ];
  if (params.draft) args.push('--draft');
  return governVcsCommand(
    'vcs:pr_create',
    {
      repository,
      repository_visibility: ghRepositoryVisibility({ ...params, repository }, run),
      ...bound,
      title: params.title.trim(),
      body,
      body_source_tier: bodySourceTier,
      ...(typeof bodyProvenance === 'object' && bodyProvenance.tier === 'confidential'
        ? { body_source_tenant: bodyProvenance.tenantSlug }
        : {}),
      draft: params.draft === true,
    },
    () => {
      if (
        computeApprovalPayloadHash(snapshot()) !== computeApprovalPayloadHash(bound) ||
        (params.bodyFile && String(safeReadFile(params.bodyFile, { encoding: 'utf8' })) !== body)
      )
        throw new Error(
          '[VCS_SNAPSHOT_CHANGED] PR source, base or review text changed before creation'
        );
      return run('gh', args, ghExecOptions(params));
    },
    true
  );
}

/** Verified repo visibility for delegation gating — never trust a claim. */
export function ghRepositoryVisibility(
  params: GhCallOptions & { repository?: { host: string; slug: string } },
  run: VcsCommandRunner = safeExecResult
): 'private' | 'public' | 'internal' | 'unknown' {
  const repo = params.repository;
  if (!repo) return 'unknown';
  try {
    const info = ghJsonSnapshot(
      ['api', `repos/${repo.slug}`, '--hostname', repo.host],
      params,
      run
    );
    if (info.private === true || info.visibility === 'private') return 'private';
    if (info.visibility === 'internal') return 'internal';
    if (info.visibility === 'public' || info.private === false) return 'public';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function ghJsonSnapshot(
  args: string[],
  options: GhCallOptions,
  run: VcsCommandRunner
): Record<string, unknown> {
  const result = ghRun(args, options, run);
  if (result.error || result.status !== 0)
    throw new Error('[VCS_SNAPSHOT_UNAVAILABLE] Cannot read GitHub publication snapshot');
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error('[VCS_SNAPSHOT_UNAVAILABLE] Invalid GitHub snapshot JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('[VCS_SNAPSHOT_UNAVAILABLE] Invalid GitHub snapshot');
  return value as Record<string, unknown>;
}

function ghPrRepository(
  options: GhCallOptions,
  run: VcsCommandRunner
): { slug: string; url: string; host: string } {
  const snapshot = ghJsonSnapshot(['repo', 'view', '--json', 'nameWithOwner,url'], options, run);
  const repo = snapshot.nameWithOwner;
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error('[VCS_SNAPSHOT_UNAVAILABLE] Repository identity required');
  const url = new URL(String(snapshot.url));
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/^\//, '').replace(/\/$/, '') !== repo
  )
    throw new Error('[VCS_SNAPSHOT_UNAVAILABLE] Repository URL required');
  return { slug: repo, url: url.toString(), host: url.host };
}

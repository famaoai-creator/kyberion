/**
 * Governed vcs-host verbs — the layer above every {@link VcsHostProvider}:
 * argument hygiene, effect construction, admission through
 * `runExternalOperation`, snapshot re-verification and error sanitization.
 * Contract and selection live in `vcs-host.ts`. Importing this module installs
 * the builtin `gh-cli` and `github-rest` providers.
 */

import { runExternalOperation } from '../governance/external-operation.js';
import { isDelegableExternalOperation } from '../governance/external-operation-target.js';
import { computeApprovalPayloadHash } from '../governance/approval-presentation.js';
import { safeExecResult, safeReadFile } from '../secure-io.js';
import { assertNotFlagLike } from './git-arguments.js';
import {
  currentPrPublicationBodySource,
  prPublicationBodySourceForPath,
  sanitizeGhOutput,
  type PrCheckEntry,
  type PrChecksResult,
  type PrListEntry,
} from './github.js';
import type { VcsCommandRunner } from './vcs-backend.js';
import { createGhCliVcsHostProvider } from './gh-cli-host-provider.js';
import {
  parseVcsPrFields,
  resolveVcsHostProvider,
  vcsHostCallContext,
  VcsHostError,
  type VcsHostAuthStatus,
  type VcsHostCallContext,
  type VcsHostCallOptions,
  type VcsHostProvider,
  type VcsPrCreateResult,
  type VcsPrListFilter,
  type VcsPrMergeResult,
  type VcsPullRequestSnapshot,
  type VcsRepositoryRef,
  type VcsRepositoryVisibility,
} from './vcs-host.js';
import './github-rest-host-provider.js';

// ─── Governed verbs ──────────────────────────────────────────────────────────

const READ_OPERATION_ID = 'vcs:github:read';

function sanitizedError(error: unknown): Error {
  if (error instanceof VcsHostError) {
    const copy = new VcsHostError(error.code, '');
    copy.message = sanitizeGhOutput(error.message);
    return copy;
  }
  return new Error(sanitizeGhOutput(error instanceof Error ? error.message : String(error)));
}

/**
 * Sanitize at the provider boundary only. Governance errors raised by
 * admission (`ExternalOperationApprovalRequired`, policy stops, outcome
 * verification) must keep their class so trusted hosts can branch on them.
 */
async function fromProvider<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw sanitizedError(error);
  }
}

async function governedRead<T>(
  operation: string,
  effect: Record<string, unknown>,
  execute: () => Promise<T>
): Promise<T> {
  return runExternalOperation(
    {
      operationId: READ_OPERATION_ID,
      effect: { operation, ...effect },
      requiresApproval: false,
      delegable: isDelegableExternalOperation(READ_OPERATION_ID),
    },
    () => fromProvider(execute),
    () => 'succeeded'
  );
}

interface Bound {
  provider: VcsHostProvider;
  ctx: VcsHostCallContext;
}

function bind(options: VcsHostCallOptions): Bound {
  const ctx = vcsHostCallContext(options);
  return { provider: resolveVcsHostProvider(options, ctx), ctx };
}

async function boundRepository({ provider, ctx }: Bound): Promise<VcsRepositoryRef> {
  const repo = await governedRead('repository', { cwd: ctx.cwd }, () => provider.repository(ctx));
  return assertRepositoryRef(repo);
}

/** Same validation as the sync `ghPrRepository`. */
export function assertRepositoryRef(repo: VcsRepositoryRef): VcsRepositoryRef {
  if (typeof repo?.slug !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo.slug))
    throw new Error('[VCS_SNAPSHOT_UNAVAILABLE] Repository identity required');
  const url = new URL(String(repo.url));
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.host !== repo.host ||
    url.pathname.replace(/^\//, '').replace(/\/$/, '') !== repo.slug
  )
    throw new Error('[VCS_SNAPSHOT_UNAVAILABLE] Repository URL required');
  return { slug: repo.slug, url: url.toString(), host: url.host };
}

export async function vcsHostRepository(
  options: VcsHostCallOptions = {}
): Promise<VcsRepositoryRef> {
  return boundRepository(bind(options));
}

export async function vcsHostDefaultBranch(options: VcsHostCallOptions = {}): Promise<string> {
  const bound = bind(options);
  const repo = await boundRepository(bound);
  const name = await governedRead('default_branch', { repository: repo }, () =>
    bound.provider.defaultBranch(bound.ctx, repo)
  );
  if (typeof name !== 'string' || !name.trim())
    throw new Error('[VCS_HOST_INVALID] default branch missing');
  return name;
}

export async function vcsHostAuthStatus(
  options: VcsHostCallOptions = {}
): Promise<VcsHostAuthStatus & { provider: string }> {
  const { provider, ctx } = bind(options);
  try {
    const status = await provider.authStatus(ctx);
    return {
      provider: provider.id,
      ok: status.ok === true,
      ...(status.detail ? { detail: sanitizeGhOutput(status.detail) } : {}),
    };
  } catch (error) {
    return { provider: provider.id, ok: false, detail: sanitizedError(error).message };
  }
}

export async function vcsHostPrView(
  params: { ref: string } & VcsHostCallOptions
): Promise<VcsPullRequestSnapshot> {
  assertNotFlagLike(params.ref, 'pr ref');
  const bound = bind(params);
  const repo = await boundRepository(bound);
  return governedRead('pr_view', { repository: repo, ref: params.ref }, () =>
    bound.provider.prView(bound.ctx, repo, params.ref)
  );
}

/**
 * gh-`--json`-shaped PR projection (`fields` is the gh comma list, limited to
 * `VCS_PR_FIELDS`), for consumers that parse gh field names directly.
 */
export async function vcsHostPrViewFields(
  params: { ref: string; fields: string } & VcsHostCallOptions
): Promise<Record<string, unknown>> {
  assertNotFlagLike(params.ref, 'pr ref');
  const fields = parseVcsPrFields(params.fields);
  const bound = bind(params);
  const repo = await boundRepository(bound);
  return governedRead('pr_fields', { repository: repo, ref: params.ref, fields }, () =>
    bound.provider.prFields(bound.ctx, repo, params.ref, fields)
  );
}

/** Read-only GitHub REST paths under `repos/{slug}/` the verb layer admits. */
const GITHUB_API_READ_PATHS: readonly RegExp[] = [
  /^$/,
  /^commits\/[^\s?]+$/,
  /^git\/trees\/[a-f0-9]{40,64}$/,
  /^branches\/[^\s/?]+\/protection\/required_status_checks$/,
  /^rules\/branches\/[^\s/?]+$/,
  /^commits\/[a-f0-9]{40,64}\/check-runs\?per_page=100&filter=latest$/,
  /^actions\/runs\?head_sha=[a-f0-9]{40,64}&per_page=100$/,
  /^contents\/\.github\/workflows\/[^\s/?]+\?ref=[a-f0-9]{40,64}$/,
];

/**
 * Governed GitHub REST GET for promotion evidence (branch protection,
 * rulesets, trees, check runs, workflow runs and contents). The path is
 * relative to `repos/{slug}/` and must match the reviewed allowlist; with
 * `allowMissing` a 404 resolves to `null` instead of throwing.
 */
export async function vcsHostGithubApiGet<T = unknown>(
  params: { path: string; allowMissing?: boolean } & VcsHostCallOptions
): Promise<T | null> {
  // Dot segments (literal or percent-encoded) would let URL normalization
  // climb out of `repos/{slug}/` past the allowlist.
  const traversal =
    /%2e|%2f|\\/i.test(params.path) ||
    params.path.split(/[/?]/).some((segment) => segment === '.' || segment === '..');
  if (traversal || !GITHUB_API_READ_PATHS.some((pattern) => pattern.test(params.path)))
    throw new Error('[VCS_TYPED_VERB_REQUIRED] GitHub API path is not an admitted read');
  const bound = bind(params);
  if (!bound.provider.githubApiGet)
    throw new VcsHostError('invalid', `provider ${bound.provider.id} has no GitHub API capability`);
  const get = bound.provider.githubApiGet.bind(bound.provider);
  const repo = await boundRepository(bound);
  try {
    return (await governedRead('github_api_get', { repository: repo, path: params.path }, () =>
      get(bound.ctx, repo, params.path)
    )) as T;
  } catch (error) {
    if (params.allowMissing && error instanceof VcsHostError && error.code === 'not_found')
      return null;
    throw error;
  }
}

/**
 * Bridge for callers that still take a `VcsCommandRunner` dependency: the
 * governed default (`safeExecResult` or none) resolves the seam, while an
 * injected runner drives a gh-cli provider (and local git) built on it.
 */
export function vcsHostOptionsForRunner(
  options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number },
  run?: VcsCommandRunner
): VcsHostCallOptions {
  const base: VcsHostCallOptions = {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  };
  if (!run || run === safeExecResult) return base;
  return { ...base, git: run, hostProvider: createGhCliVcsHostProvider({ run }) };
}

export async function vcsHostPrList(
  params: Partial<VcsPrListFilter> & VcsHostCallOptions = {}
): Promise<PrListEntry[]> {
  if (params.head) assertNotFlagLike(params.head, 'head branch');
  const filter: VcsPrListFilter = {
    state: params.state ?? 'open',
    limit: params.limit ?? 100,
    ...(params.head ? { head: params.head } : {}),
  };
  const bound = bind(params);
  const repo = await boundRepository(bound);
  return governedRead('pr_list', { repository: repo, ...filter }, () =>
    bound.provider.prList(bound.ctx, repo, filter)
  );
}

/** Same verdict rules as the sync `ghPrChecks`. */
export function summarizePrChecks(all: PrCheckEntry[], ignore: string[] = []): PrChecksResult {
  const ignored = new Set(ignore);
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

export async function vcsHostPrChecks(
  params: { ref: string; ignore?: string[] } & VcsHostCallOptions
): Promise<PrChecksResult> {
  assertNotFlagLike(params.ref, 'pr ref');
  const bound = bind(params);
  const repo = await boundRepository(bound);
  const rows = await governedRead('pr_checks', { repository: repo, ref: params.ref }, () =>
    bound.provider.prChecks(bound.ctx, repo, params.ref)
  );
  return summarizePrChecks(rows, params.ignore);
}

export interface VcsHostPrChecksWaitResult extends PrChecksResult {
  waited_ms: number;
  timed_out: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll until every check reaches a terminal bucket or `timeoutMs` elapses —
 * same semantics as the sync `ghPrChecksWait`: 'none' is not terminal, a few
 * consecutive transient failures are tolerated, and a timeout returns the last
 * observed state with `timed_out: true` (callers fail closed on it).
 */
export async function vcsHostPrChecksWait(
  params: {
    ref: string;
    ignore?: string[];
    intervalMs?: number;
    timeoutMs?: number;
  } & VcsHostCallOptions,
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<VcsHostPrChecksWaitResult> {
  const intervalMs = Math.max(1000, params.intervalMs ?? 15_000);
  const timeoutMs = params.timeoutMs ?? 20 * 60_000;
  const started = Date.now();
  const perCallTimeoutMs = Math.min(60_000, timeoutMs);
  const maxConsecutiveErrors = 3;
  let consecutiveErrors = 0;
  let last: PrChecksResult = { state: 'none', checks: [], failing: [], pending: [] };
  for (;;) {
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) break;
    try {
      last = await vcsHostPrChecks({
        ...params,
        timeoutMs: Math.min(perCallTimeoutMs, Math.max(1000, timeoutMs - elapsed)),
      });
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= maxConsecutiveErrors) {
        throw new Error(
          `[VCS_GH_WAIT_FAILED] pr checks ${params.ref}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    if (last.state !== 'pending' && last.state !== 'none') break;
    await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - (Date.now() - started))));
  }
  const timedOut =
    (last.state === 'pending' || last.state === 'none') && Date.now() - started >= timeoutMs;
  return { ...last, waited_ms: Date.now() - started, timed_out: timedOut };
}

export async function vcsHostPrQueued(
  params: { number: number } & VcsHostCallOptions
): Promise<boolean> {
  if (!Number.isInteger(params.number) || params.number < 1)
    throw new Error('[VCS_HOST_INVALID] pr number required');
  const bound = bind(params);
  const repo = await boundRepository(bound);
  return governedRead('pr_queued', { repository: repo, number: params.number }, () =>
    bound.provider.prQueued(bound.ctx, repo, params.number)
  );
}

async function visibilityOf(
  bound: Bound,
  repo: VcsRepositoryRef
): Promise<VcsRepositoryVisibility> {
  try {
    return await governedRead('visibility', { repository: repo }, () =>
      bound.provider.visibility(bound.ctx, repo)
    );
  } catch {
    // Same contract as the sync verb: an unverifiable visibility is 'unknown',
    // which delegation treats as not-private.
    return 'unknown';
  }
}

const SHA = /^[a-f0-9]{40,64}$/i;

export interface VcsHostPrCreateParams extends VcsHostCallOptions {
  title: string;
  body?: string;
  bodyFile?: string;
  base?: string;
  head?: string;
  draft?: boolean;
}

/**
 * Governed PR creation. The effect is byte-identical to the sync
 * `ghPrCreate` effect, so an approval granted for either path binds both.
 */
export async function vcsHostPrCreate(params: VcsHostPrCreateParams): Promise<VcsPrCreateResult> {
  if (!params.title?.trim()) throw new Error('[VCS_GH_INVALID] pr create requires a title');
  if (params.head !== undefined) assertNotFlagLike(params.head, 'head');
  if (params.base !== undefined) assertNotFlagLike(params.base, 'base');
  const bound = bind(params);
  const { provider, ctx } = bound;
  const repo = await boundRepository(bound);
  const localRead = (args: string[]) => {
    const result = ctx.git('git', args, { cwd: params.cwd });
    if (result.error || result.status !== 0 || !result.stdout.trim())
      throw new Error('[VCS_SNAPSHOT_UNAVAILABLE] Cannot resolve PR source');
    return result.stdout.trim();
  };
  const head = params.head?.trim() || localRead(['symbolic-ref', '--short', 'HEAD']);
  const base =
    params.base?.trim() ||
    (await governedRead('default_branch', { repository: repo }, () =>
      provider.defaultBranch(ctx, repo)
    ));
  assertNotFlagLike(head, 'head');
  assertNotFlagLike(base, 'base');
  const inheritedSource = currentPrPublicationBodySource();
  const body = params.bodyFile
    ? String(safeReadFile(params.bodyFile, { encoding: 'utf8' }))
    : inheritedSource
      ? (params.body ?? '')
      : params.body?.trim() || '';
  const bodyProvenance = params.bodyFile
    ? prPublicationBodySourceForPath(params.bodyFile)
    : (inheritedSource ?? 'inline');
  const bodySourceTier = typeof bodyProvenance === 'object' ? bodyProvenance.tier : bodyProvenance;
  const remoteSha = (ref: string) =>
    governedRead('commit', { repository: repo, ref }, () => provider.commitSha(ctx, repo, ref));
  const snapshot = async () => ({
    head,
    base,
    headSha: localRead(['rev-parse', '--verify', `${head}^{commit}`]),
    remoteHead: await remoteSha(head),
    remoteBase: await remoteSha(base),
  });
  const bound0 = await snapshot();
  if (
    !SHA.test(bound0.headSha) ||
    bound0.remoteHead !== bound0.headSha ||
    !SHA.test(String(bound0.remoteBase))
  )
    throw new Error(
      '[VCS_SNAPSHOT_UNAVAILABLE] Push the exact PR source commit before creating a PR'
    );
  const title = params.title.trim();
  const effect = {
    repository: repo,
    repository_visibility: await visibilityOf(bound, repo),
    ...bound0,
    title,
    body,
    body_source_tier: bodySourceTier,
    ...(typeof bodyProvenance === 'object' && bodyProvenance.tier === 'confidential'
      ? { body_source_tenant: bodyProvenance.tenantSlug }
      : {}),
    draft: params.draft === true,
  };
  return runExternalOperation(
    {
      operationId: 'vcs:pr_create',
      effect,
      requiresApproval: true,
      delegable: isDelegableExternalOperation('vcs:pr_create'),
    },
    async () => {
      if (
        computeApprovalPayloadHash(await snapshot()) !== computeApprovalPayloadHash(bound0) ||
        (params.bodyFile && String(safeReadFile(params.bodyFile, { encoding: 'utf8' })) !== body)
      )
        throw new Error(
          '[VCS_SNAPSHOT_CHANGED] PR source, base or review text changed before creation'
        );
      return fromProvider(() =>
        provider.prCreate(ctx, repo, {
          title,
          body,
          base,
          head,
          draft: params.draft === true,
        })
      );
    },
    (result) => (Number.isInteger(result?.number) && result.number > 0 ? 'succeeded' : 'unknown')
  );
}

export interface VcsHostPrMergeParams extends VcsHostCallOptions {
  ref: string;
  method?: 'merge' | 'squash' | 'rebase';
  deleteBranch?: boolean;
  expectedHeadSha?: string;
  expectedBaseSha?: string;
}

const MERGE_SNAPSHOT_FIELDS = [
  'number',
  'url',
  'headRefOid',
  'baseRefOid',
  'baseRefName',
  'headRefName',
] as const;

/** Governed merge; effect identical to the sync `ghPrMerge`. */
export async function vcsHostPrMerge(params: VcsHostPrMergeParams): Promise<VcsPrMergeResult> {
  assertNotFlagLike(params.ref, 'pr ref');
  const bound = bind(params);
  const { provider, ctx } = bound;
  const repo = await boundRepository(bound);
  const snapshot = async () => {
    const view = await governedRead('pr_view', { repository: repo, ref: params.ref }, () =>
      provider.prView(ctx, repo, params.ref)
    );
    return Object.fromEntries(MERGE_SNAPSHOT_FIELDS.map((key) => [key, view[key]])) as Pick<
      VcsPullRequestSnapshot,
      (typeof MERGE_SNAPSHOT_FIELDS)[number]
    >;
  };
  const snap = await snapshot();
  if (
    (params.expectedHeadSha !== undefined && params.expectedHeadSha !== snap.headRefOid) ||
    (params.expectedBaseSha !== undefined && params.expectedBaseSha !== snap.baseRefOid)
  )
    throw new Error('[VCS_REVIEW_STALE] PR differs from the verified promotion revision');
  if (!Number.isInteger(snap.number) || !SHA.test(String(snap.headRefOid)))
    throw new Error('[VCS_SNAPSHOT_UNAVAILABLE] PR identity and head commit required');
  if (snap.url !== `${repo.url.replace(/\/$/, '')}/pull/${snap.number}`)
    throw new Error('[VCS_SNAPSHOT_UNAVAILABLE] PR belongs to a different repository');
  const method = params.method || 'merge';
  const deleteBranch = params.deleteBranch !== false;
  return runExternalOperation(
    {
      operationId: 'vcs:pr_merge',
      effect: {
        repository: repo,
        repository_visibility: await visibilityOf(bound, repo),
        ...snap,
        method,
        deleteBranch,
      },
      requiresApproval: true,
      delegable: isDelegableExternalOperation('vcs:pr_merge'),
    },
    async () => {
      if (computeApprovalPayloadHash(await snapshot()) !== computeApprovalPayloadHash(snap))
        throw new Error('[VCS_SNAPSHOT_CHANGED] PR changed before merge');
      return fromProvider(() =>
        provider.prMerge(ctx, repo, {
          number: snap.number,
          method,
          deleteBranch,
          expectedHeadSha: snap.headRefOid,
          headRefName: snap.headRefName,
        })
      );
    },
    (result) => (result?.merged === true ? 'succeeded' : 'unknown')
  );
}

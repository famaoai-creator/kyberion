/**
 * vcs-host seam — forge operations (pull requests, checks, repository
 * metadata) behind a typed, asynchronous provider contract.
 *
 * `vcs-backend` decides WHERE `git <argv>` executes and stays a synchronous
 * command-runner envelope. Forge operations are a different shape: HTTP APIs
 * are asynchronous and return structured data, so forcing them through a
 * git-CLI stdout envelope would neither be honest about fidelity nor work
 * without blocking I/O. The two seams are orthogonal (local git + GitHub REST,
 * remote executor + gh CLI, …).
 *
 * Verbs: `vcs-host-verbs.ts`. Layering (docs/developer/improvement-plans-2026-11/VCS_HOST_API_SEAM_DESIGN_2026-11-04.ja.md):
 *
 *   verbs in this module  — argument hygiene, cwd scope, effect construction,
 *                           governed admission (`runExternalOperation`),
 *                           snapshot re-verification before a mutation,
 *                           error sanitization
 *   VcsHostProvider       — transport only (`gh-cli`, `github-rest`, `memory`)
 *
 * Invariants:
 * - Operation ids and effect shapes are provider independent and identical to
 *   the synchronous `github.ts` verbs, so approval hashes, delegation targets
 *   (`external-operation-target.ts`) and protected effect paths
 *   (`operation-protection.ts`) are unchanged by switching providers. The
 *   provider id is never part of an effect.
 * - A merge always carries the approved head commit to the host
 *   (`expectedHeadSha`), and the snapshot is re-read and hash-compared inside
 *   the governed execute step.
 * - Credentials come from registered env only (`GH_TOKEN`/`GITHUB_TOKEN`) and
 *   travel in `VcsHostCallContext.env`; providers never read `process.env`.
 *
 * Selection: explicit id → saved seam default (`KYBERION_SEAM_DEFAULTS`) →
 * governed `seam-provider-selection/vcs-host.json` chain, taking the first
 * registered provider whose cheap `isAvailable()` holds. Fail-closed with
 * `[VCS_HOST_UNAVAILABLE]` when none is.
 */

import { createProviderRegistry } from '../provider/provider-registry.js';
import type { SeamProviderMetadata } from '../seam.js';
import {
  getSeamSelectionPolicy,
  resolveSeamDefaultOrder,
  savedSeamDefaultFor,
} from '../provider/seam-provider-selection.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { assertVcsCwdScope } from './cwd-scope.js';
import { vcsDefaultRunner, type VcsCommandRunner } from './vcs-backend.js';
import type { PrCheckEntry, PrListEntry } from './github.js';

export const VCS_HOST_SEAM = 'vcs-host';
export const GH_CLI_VCS_HOST_ID = 'gh-cli';
export const GITHUB_REST_VCS_HOST_ID = 'github-rest';
export const MEMORY_VCS_HOST_ID = 'memory';

// ─── Contract ────────────────────────────────────────────────────────────────

/** Canonical repository identity; same shape as the sync `ghPrRepository`. */
export interface VcsRepositoryRef {
  /** `owner/name`. */
  slug: string;
  /** Canonical `https://host/owner/name` (no trailing slash, no credentials). */
  url: string;
  /** URL host (GitHub.com or an Enterprise Server hostname). */
  host: string;
}

export interface VcsHostCallContext {
  /** Working checkout, already cwd-scope asserted by the verb layer. */
  cwd?: string;
  /** Registered credentials (+ explicit caller overrides). */
  env: Record<string, string | undefined>;
  timeoutMs?: number;
  /** git runner for local repository facts (remote URL); vcs-backend default. */
  git: VcsCommandRunner;
}

export type VcsRepositoryVisibility = 'private' | 'public' | 'internal' | 'unknown';

export interface VcsPullRequestSnapshot {
  number: number;
  url: string;
  headRefOid: string;
  baseRefOid: string;
  headRefName: string;
  baseRefName: string;
  /** `OPEN` | `CLOSED` | `MERGED` (gh JSON casing). */
  state: string;
  title: string;
  isDraft: boolean;
}

export interface VcsPrListFilter {
  state: 'open' | 'closed' | 'merged' | 'all';
  limit: number;
  head?: string;
}

export interface VcsPrCreateInput {
  title: string;
  body: string;
  base: string;
  head: string;
  draft: boolean;
}

export interface VcsPrCreateResult {
  number: number;
  url: string;
}

export interface VcsPrMergeInput {
  number: number;
  method: 'merge' | 'squash' | 'rebase';
  deleteBranch: boolean;
  /** The approved head commit; the host must refuse the merge on mismatch. */
  expectedHeadSha: string;
  headRefName: string;
}

export interface VcsPrMergeResult {
  number: number;
  merged: true;
}

export type VcsHostErrorCode =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'stale_head'
  | 'rate_limited'
  | 'invalid'
  | 'unavailable';

/** Provider failure. `message` is sanitized again by the verb layer. */
export class VcsHostError extends Error {
  constructor(
    readonly code: VcsHostErrorCode,
    message: string
  ) {
    super(`[VCS_HOST_${code.toUpperCase()}] ${message}`);
    this.name = 'VcsHostError';
  }
}

export interface VcsHostAuthStatus {
  ok: boolean;
  detail?: string;
}

export interface VcsHostProvider {
  readonly id: string;
  /** Cheap, side-effect free: can this provider run here at all? */
  isAvailable(ctx: VcsHostCallContext): boolean;
  authStatus(ctx: VcsHostCallContext): Promise<VcsHostAuthStatus>;
  repository(ctx: VcsHostCallContext): Promise<VcsRepositoryRef>;
  defaultBranch(ctx: VcsHostCallContext, repo: VcsRepositoryRef): Promise<string>;
  visibility(ctx: VcsHostCallContext, repo: VcsRepositoryRef): Promise<VcsRepositoryVisibility>;
  /** Commit sha the host resolves `ref` (branch / sha) to. */
  commitSha(ctx: VcsHostCallContext, repo: VcsRepositoryRef, ref: string): Promise<string>;
  /** `ref` is a PR number, PR URL or head branch name. */
  prView(
    ctx: VcsHostCallContext,
    repo: VcsRepositoryRef,
    ref: string
  ): Promise<VcsPullRequestSnapshot>;
  prList(
    ctx: VcsHostCallContext,
    repo: VcsRepositoryRef,
    filter: VcsPrListFilter
  ): Promise<PrListEntry[]>;
  /** Raw check rows (gh bucket vocabulary); the verb layer computes the verdict. */
  prChecks(ctx: VcsHostCallContext, repo: VcsRepositoryRef, ref: string): Promise<PrCheckEntry[]>;
  prQueued(ctx: VcsHostCallContext, repo: VcsRepositoryRef, number: number): Promise<boolean>;
  prCreate(
    ctx: VcsHostCallContext,
    repo: VcsRepositoryRef,
    input: VcsPrCreateInput
  ): Promise<VcsPrCreateResult>;
  prMerge(
    ctx: VcsHostCallContext,
    repo: VcsRepositoryRef,
    input: VcsPrMergeInput
  ): Promise<VcsPrMergeResult>;
  /**
   * gh-`--json`-shaped projection of one PR, limited to {@link VCS_PR_FIELDS}.
   * Field names and value shapes follow the gh CLI so existing consumers keep
   * their parsing; a provider that cannot serve a field throws `invalid`.
   */
  prFields(
    ctx: VcsHostCallContext,
    repo: VcsRepositoryRef,
    ref: string,
    fields: readonly VcsPrField[]
  ): Promise<Record<string, unknown>>;
  /**
   * Optional GitHub capability: a REST GET under `repos/{slug}/` for the
   * allowlisted read-only paths the verb layer admits (branch protection,
   * rulesets, trees, check runs, workflow runs, workflow contents). Throws
   * `not_found` for a 404 so callers can treat a missing policy as absent.
   */
  githubApiGet?(ctx: VcsHostCallContext, repo: VcsRepositoryRef, path: string): Promise<unknown>;
}

/** gh `--json` PR field names served by the contract (both builtin providers). */
export const VCS_PR_FIELDS = [
  'number',
  'url',
  'title',
  'body',
  'state',
  'isDraft',
  'headRefOid',
  'baseRefOid',
  'headRefName',
  'baseRefName',
  'author',
  'createdAt',
  'updatedAt',
  'closedAt',
  'mergedAt',
  'mergeCommit',
  'autoMergeRequest',
  'additions',
  'deletions',
  'changedFiles',
  'files',
  'labels',
] as const;
export type VcsPrField = (typeof VCS_PR_FIELDS)[number];

export function parseVcsPrFields(fields: string): VcsPrField[] {
  const names = fields
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (!names.length) throw new VcsHostError('invalid', 'at least one PR field is required');
  const allowed = new Set<string>(VCS_PR_FIELDS);
  const unknown = names.filter((name) => !allowed.has(name));
  if (unknown.length)
    throw new VcsHostError(
      'invalid',
      `unsupported PR field(s): ${unknown.join(', ')} — supported: ${VCS_PR_FIELDS.join(', ')}`
    );
  return [...new Set(names)] as VcsPrField[];
}

// ─── Registry & resolution ───────────────────────────────────────────────────

const vcsHostRegistry = createProviderRegistry<VcsHostProvider>({
  seam: VCS_HOST_SEAM,
  owner: 'libs/core/vcs/vcs-host.ts',
  source: 'vcs-host-extension',
  missingIdError: 'VcsHostProvider must have a non-empty id',
});

export function registerVcsHostProvider(
  provider: VcsHostProvider,
  metadata?: SeamProviderMetadata
): () => void {
  return vcsHostRegistry.register(provider, metadata);
}

export function listVcsHostProviders(): VcsHostProvider[] {
  return vcsHostRegistry.list();
}

export function getVcsHostProvider(id: string): VcsHostProvider | undefined {
  return vcsHostRegistry.get(id);
}

export function resetVcsHostProviders(): void {
  vcsHostRegistry.reset();
}

export interface VcsHostCallOptions {
  cwd?: string;
  /** Explicit credential overrides (same channel as the sync gh verbs). */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Explicit provider id; never relaxes approval or egress policy. */
  provider?: string;
  /**
   * Explicit provider instance (dependency injection for callers that already
   * own a runner, e.g. an actuator's governed exec). Wins over `provider`.
   * Never relaxes approval or egress policy: the verb layer still governs.
   */
  hostProvider?: VcsHostProvider;
  /** git runner for local facts; defaults to the governed vcs-backend. */
  git?: VcsCommandRunner;
}

export function vcsHostCallContext(options: VcsHostCallOptions): VcsHostCallContext {
  assertVcsCwdScope(options.cwd);
  const registered = {
    GH_TOKEN: getRegisteredEnvText('GH_TOKEN'),
    GITHUB_TOKEN: getRegisteredEnvText('GITHUB_TOKEN'),
  };
  return {
    cwd: options.cwd,
    env: {
      ...Object.fromEntries(Object.entries(registered).filter(([, value]) => value)),
      ...(options.env ?? {}),
    },
    timeoutMs: options.timeoutMs,
    git: options.git ?? vcsDefaultRunner,
  };
}

/** Governed provider choice for one call; see the module comment. */
export function resolveVcsHostProvider(
  options: VcsHostCallOptions = {},
  ctx: VcsHostCallContext = vcsHostCallContext(options)
): VcsHostProvider {
  if (options.hostProvider) return options.hostProvider;
  const explicit = options.provider?.trim();
  if (explicit) {
    const provider = vcsHostRegistry.get(explicit);
    if (!provider) {
      throw new Error(
        `[VCS_HOST_UNAVAILABLE] unknown provider '${explicit}' — registered: ${
          vcsHostRegistry
            .list()
            .map((p) => p.id)
            .join(', ') || '(none)'
        }`
      );
    }
    return provider;
  }
  const chain = resolveSeamDefaultOrder(VCS_HOST_SEAM, {
    builtin: [GH_CLI_VCS_HOST_ID, GITHUB_REST_VCS_HOST_ID],
  });
  for (const id of chain) {
    const provider = vcsHostRegistry.get(id);
    if (provider && safeAvailable(provider, ctx)) return provider;
  }
  throw new Error(
    `[VCS_HOST_UNAVAILABLE] no available VCS host provider (tried ${chain.join(', ') || 'none'}) — install and authenticate the GitHub CLI, or register GH_TOKEN for github-rest`
  );
}

export interface VcsHostSelectionCandidate {
  id: string;
  registered: boolean;
  available: boolean;
}

export interface VcsHostSelection {
  /** Provider the default chain would pick, or undefined when none is available. */
  selected?: string;
  /** Default chain in resolution order. */
  chain: string[];
  /** Where the head of the chain comes from (saved/env default layer, policy or builtin). */
  source: string;
  candidates: VcsHostSelectionCandidate[];
}

/**
 * Explain the default-chain resolution without performing any forge call:
 * the same chain and `isAvailable()` checks as {@link resolveVcsHostProvider}
 * (gh-cli runs `gh --version` locally; github-rest only checks for a
 * registered token). Never touches the network.
 */
export function inspectVcsHostSelection(
  options: Pick<VcsHostCallOptions, 'cwd' | 'env'> = {}
): VcsHostSelection {
  const ctx = vcsHostCallContext(options);
  const chain = resolveSeamDefaultOrder(VCS_HOST_SEAM, {
    builtin: [GH_CLI_VCS_HOST_ID, GITHUB_REST_VCS_HOST_ID],
  });
  const saved = savedSeamDefaultFor(VCS_HOST_SEAM);
  let source = 'builtin';
  if (saved) source = saved.source;
  else {
    try {
      if (getSeamSelectionPolicy(VCS_HOST_SEAM)) source = 'policy';
    } catch {
      /* policy directory unavailable: builtin order */
    }
  }
  const candidates = chain.map((id) => {
    const provider = vcsHostRegistry.get(id);
    return {
      id,
      registered: Boolean(provider),
      available: provider ? safeAvailable(provider, ctx) : false,
    };
  });
  const selected = candidates.find((candidate) => candidate.available)?.id;
  return { ...(selected ? { selected } : {}), chain, source, candidates };
}

function safeAvailable(provider: VcsHostProvider, ctx: VcsHostCallContext): boolean {
  try {
    return provider.isAvailable(ctx) === true;
  } catch {
    return false;
  }
}

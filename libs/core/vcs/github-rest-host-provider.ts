/**
 * github-rest vcs-host provider — GitHub REST/GraphQL over governed
 * `secureFetch`, for runtimes without the `gh` binary (containers, remote
 * workers). Transport only; governance lives in `vcs-host.ts`.
 *
 * - Credentials: `GH_TOKEN`/`GITHUB_TOKEN` from `ctx.env` (registered env,
 *   assembled by the verb layer), sent only as the Authorization header.
 * - Hosts: github.com → `https://api.github.com`; any other host is treated as
 *   GitHub Enterprise Server (`https://<host>/api/v3`, `/api/graphql`).
 *   Local-network hosts are refused by `secureFetch` (no opt-in here).
 * - Repository identity comes from the checkout's `origin` remote, read through
 *   the governed git runner, and is normalized to the same
 *   `https://host/owner/name` shape the gh-cli provider returns.
 * - Merge sends the approved head as `sha`, so GitHub refuses a moved head (409).
 *
 * Importing this module installs `github-rest` on the vcs-host seam; it is only
 * available when a token is registered.
 */

import type { SecureFetchOptions } from '../network.js';
import type { PrCheckEntry, PrListEntry } from './github.js';
import {
  GITHUB_REST_VCS_HOST_ID,
  registerVcsHostProvider,
  VcsHostError,
  type VcsHostCallContext,
  type VcsHostErrorCode,
  type VcsHostProvider,
  type VcsPullRequestSnapshot,
  type VcsRepositoryRef,
} from './vcs-host.js';

export type GithubRestFetch = <T = unknown>(options: SecureFetchOptions) => Promise<T>;

const PR_QUEUE_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){mergeQueueEntry{id}}}}';

function token(ctx: VcsHostCallContext): string | undefined {
  return ctx.env.GH_TOKEN || ctx.env.GITHUB_TOKEN || undefined;
}

function apiBase(host: string): { rest: string; graphql: string } {
  if (host === 'github.com')
    return { rest: 'https://api.github.com', graphql: 'https://api.github.com/graphql' };
  return { rest: `https://${host}/api/v3`, graphql: `https://${host}/api/graphql` };
}

function codeForStatus(status: number | undefined, path: string): VcsHostErrorCode {
  switch (status) {
    case 401:
      return 'auth';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return path.endsWith('/merge') ? 'stale_head' : 'conflict';
    case 405:
      return 'conflict';
    case 422:
      return 'invalid';
    case 429:
      return 'rate_limited';
    default:
      return 'unavailable';
  }
}

/** Parse an origin remote (https, ssh, scp-like) into the canonical ref. */
export function parseGithubRemote(remote: string): VcsRepositoryRef {
  const trimmed = remote.trim();
  let host: string;
  let path: string;
  const scp = trimmed.match(/^[\w.-]+@([\w.-]+):(.+)$/);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new VcsHostError('invalid', 'origin remote is not a URL');
    }
    if (!['https:', 'ssh:', 'git+ssh:'].includes(url.protocol))
      throw new VcsHostError('invalid', 'origin remote protocol unsupported');
    host = url.host;
    path = url.pathname;
  }
  const slug = path
    .replace(/^\//, '')
    .replace(/\/$/, '')
    .replace(/\.git$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug))
    throw new VcsHostError('invalid', 'origin remote is not owner/name');
  const url = new URL(`https://${host}/${slug}`);
  return { slug, url: url.toString(), host: url.host };
}

function prNumberFromRef(ref: string): number | undefined {
  if (/^[1-9][0-9]*$/.test(ref)) return Number(ref);
  const match = ref.match(/\/pull\/([1-9][0-9]*)\/?$/);
  return match ? Number(match[1]) : undefined;
}

interface RestPull {
  number: number;
  html_url: string;
  title: string;
  state: 'open' | 'closed';
  draft?: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
  created_at?: string;
  updated_at?: string;
  body?: string | null;
  merge_commit_sha?: string | null;
  auto_merge?: unknown;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  labels?: Array<{ name?: string }>;
  user?: { login?: string };
  head: { sha: string; ref: string; repo?: { full_name?: string } | null };
  base: { sha: string; ref: string };
}

/** Project a REST pull onto gh `--json` field names and shapes. */
export function restPullField(pull: RestPull, field: string): unknown {
  switch (field) {
    case 'number':
      return pull.number;
    case 'url':
      return pull.html_url;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body ?? '';
    case 'state':
      return pullState(pull);
    case 'isDraft':
      return pull.draft === true;
    case 'headRefOid':
      return pull.head.sha;
    case 'baseRefOid':
      return pull.base.sha;
    case 'headRefName':
      return pull.head.ref;
    case 'baseRefName':
      return pull.base.ref;
    case 'author':
      return { login: pull.user?.login ?? '' };
    case 'createdAt':
      return pull.created_at ?? null;
    case 'updatedAt':
      return pull.updated_at ?? null;
    case 'closedAt':
      return pull.closed_at ?? null;
    case 'mergedAt':
      return pull.merged_at ?? null;
    // REST reports a test-merge sha on open PRs; gh exposes a merge commit only once merged.
    case 'mergeCommit':
      return pull.merged_at && pull.merge_commit_sha ? { oid: pull.merge_commit_sha } : null;
    case 'autoMergeRequest':
      return pull.auto_merge ?? null;
    case 'additions':
      return pull.additions ?? 0;
    case 'deletions':
      return pull.deletions ?? 0;
    case 'changedFiles':
      return pull.changed_files ?? 0;
    case 'labels':
      return (pull.labels ?? []).map((label) => ({ name: label.name ?? '' }));
    default:
      throw new VcsHostError('invalid', `github-rest cannot serve PR field ${field}`);
  }
}

function pullState(pull: RestPull): string {
  if (pull.merged_at) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** Map a check-run conclusion/status onto the gh bucket vocabulary. */
export function checkRunBucket(status: string, conclusion: string | null | undefined): string {
  if (status !== 'completed') return 'pending';
  switch (conclusion) {
    case 'success':
    case 'neutral':
      return 'pass';
    case 'skipped':
      return 'skipping';
    case 'cancelled':
      return 'cancel';
    default:
      return 'fail';
  }
}

function statusBucket(state: string): string {
  if (state === 'success') return 'pass';
  if (state === 'pending') return 'pending';
  return 'fail';
}

export function createGithubRestVcsHostProvider(
  options: { fetch?: GithubRestFetch } = {}
): VcsHostProvider {
  const doFetch: GithubRestFetch =
    options.fetch ??
    (async <T>(request: SecureFetchOptions) => {
      const { secureFetch } = await import('../network.js');
      return secureFetch<T>(request);
    });

  const request = async <T>(
    ctx: VcsHostCallContext,
    repo: Pick<VcsRepositoryRef, 'host'>,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    data?: unknown,
    graphql = false
  ): Promise<T> => {
    const auth = token(ctx);
    if (!auth) throw new VcsHostError('auth', 'no GH_TOKEN/GITHUB_TOKEN registered');
    const base = apiBase(repo.host);
    try {
      return await doFetch<T>({
        method,
        url: graphql ? base.graphql : `${base.rest}${path}`,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${auth}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        ...(data !== undefined ? { data } : {}),
        ...(ctx.timeoutMs ? { timeout: ctx.timeoutMs } : {}),
        authenticateRequest: true,
      });
    } catch (error) {
      if (error instanceof VcsHostError) throw error;
      const status = (error as { httpStatus?: number }).httpStatus;
      throw new VcsHostError(
        codeForStatus(status, path),
        `GitHub API ${method} ${graphql ? 'graphql' : path.split('?')[0]} failed${
          status ? ` (${status})` : ''
        }`
      );
    }
  };

  const pull = async (ctx: VcsHostCallContext, repo: VcsRepositoryRef, ref: string) => {
    const number = prNumberFromRef(ref);
    if (number !== undefined)
      return request<RestPull>(ctx, repo, 'GET', `/repos/${repo.slug}/pulls/${number}`);
    const owner = repo.slug.split('/')[0];
    const rows = await request<RestPull[]>(
      ctx,
      repo,
      'GET',
      `/repos/${repo.slug}/pulls?state=all&per_page=1&head=${encodeURIComponent(`${owner}:${ref}`)}`
    );
    if (!rows[0]) throw new VcsHostError('not_found', 'no pull request for branch');
    return rows[0];
  };

  return {
    id: GITHUB_REST_VCS_HOST_ID,
    isAvailable(ctx) {
      return Boolean(token(ctx));
    },
    async authStatus(ctx) {
      // Host is unknown before repository resolution; probe the configured origin when possible.
      let host = 'github.com';
      try {
        host = (await this.repository(ctx)).host;
      } catch {
        /* fall back to github.com */
      }
      await request(ctx, { host }, 'GET', '/user');
      return { ok: true };
    },
    async repository(ctx) {
      const result = ctx.git('git', ['remote', 'get-url', 'origin'], { cwd: ctx.cwd });
      if (result.error || result.status !== 0 || !result.stdout.trim())
        throw new VcsHostError('not_found', 'checkout has no origin remote');
      return parseGithubRemote(result.stdout);
    },
    async defaultBranch(ctx, repo) {
      const row = await request<{ default_branch?: string }>(
        ctx,
        repo,
        'GET',
        `/repos/${repo.slug}`
      );
      return String(row.default_branch ?? '');
    },
    async visibility(ctx, repo) {
      const info = await request<{ private?: boolean; visibility?: string }>(
        ctx,
        repo,
        'GET',
        `/repos/${repo.slug}`
      );
      if (info.private === true || info.visibility === 'private') return 'private';
      if (info.visibility === 'internal') return 'internal';
      if (info.visibility === 'public' || info.private === false) return 'public';
      return 'unknown';
    },
    async commitSha(ctx, repo, ref) {
      const row = await request<{ sha?: string }>(
        ctx,
        repo,
        'GET',
        `/repos/${repo.slug}/commits/${encodeURIComponent(ref)}`
      );
      return String(row.sha ?? '');
    },
    async prView(ctx, repo, ref): Promise<VcsPullRequestSnapshot> {
      const row = await pull(ctx, repo, ref);
      return {
        number: row.number,
        url: row.html_url,
        headRefOid: row.head.sha,
        baseRefOid: row.base.sha,
        headRefName: row.head.ref,
        baseRefName: row.base.ref,
        state: pullState(row),
        title: row.title,
        isDraft: row.draft === true,
      };
    },
    async prList(ctx, repo, filter): Promise<PrListEntry[]> {
      const state = filter.state === 'merged' ? 'closed' : filter.state;
      const owner = repo.slug.split('/')[0];
      const rows = await request<RestPull[]>(
        ctx,
        repo,
        'GET',
        `/repos/${repo.slug}/pulls?state=${state}&per_page=${Math.min(100, Math.max(1, filter.limit))}${
          filter.head ? `&head=${encodeURIComponent(`${owner}:${filter.head}`)}` : ''
        }`
      );
      return rows
        .filter((row) => filter.state !== 'merged' || Boolean(row.merged_at))
        .slice(0, filter.limit)
        .map((row) => ({
          number: row.number,
          title: row.title,
          headRefOid: row.head.sha,
          headRefName: row.head.ref,
          isDraft: row.draft === true,
          author: { login: row.user?.login },
          state: pullState(row),
        }));
    },
    async prChecks(ctx, repo, ref): Promise<PrCheckEntry[]> {
      const sha = (await pull(ctx, repo, ref)).head.sha;
      const runs = await request<{
        check_runs?: Array<{
          name: string;
          status: string;
          conclusion?: string | null;
          html_url?: string;
        }>;
      }>(
        ctx,
        repo,
        'GET',
        `/repos/${repo.slug}/commits/${sha}/check-runs?per_page=100&filter=latest`
      );
      const combined = await request<{
        statuses?: Array<{ context: string; state: string; target_url?: string | null }>;
      }>(ctx, repo, 'GET', `/repos/${repo.slug}/commits/${sha}/status`);
      return [
        ...(runs.check_runs ?? []).map((run) => ({
          name: run.name,
          state: (run.conclusion ?? run.status).toUpperCase(),
          bucket: checkRunBucket(run.status, run.conclusion),
          ...(run.html_url ? { link: run.html_url } : {}),
        })),
        ...(combined.statuses ?? []).map((status) => ({
          name: status.context,
          state: status.state.toUpperCase(),
          bucket: statusBucket(status.state),
          ...(status.target_url ? { link: status.target_url } : {}),
        })),
      ];
    },
    async prQueued(ctx, repo, number) {
      const [owner, name] = repo.slug.split('/');
      const row = await request<{
        errors?: unknown;
        data?: { repository?: { pullRequest?: { mergeQueueEntry: unknown } } };
      }>(
        ctx,
        repo,
        'POST',
        '',
        { query: PR_QUEUE_QUERY, variables: { owner, name, number } },
        true
      );
      if (row.errors || !row.data?.repository?.pullRequest)
        throw new VcsHostError('unavailable', 'Cannot verify server merge queue');
      return Boolean(row.data.repository.pullRequest.mergeQueueEntry);
    },
    async prCreate(ctx, repo, input) {
      const row = await request<{ number?: number; html_url?: string }>(
        ctx,
        repo,
        'POST',
        `/repos/${repo.slug}/pulls`,
        {
          title: input.title,
          body: input.body,
          base: input.base,
          head: input.head,
          draft: input.draft,
        }
      );
      if (!Number.isInteger(row.number) || typeof row.html_url !== 'string')
        throw new VcsHostError('invalid', 'GitHub API returned no pull request');
      return { number: row.number as number, url: row.html_url };
    },
    async prFields(ctx, repo, ref, fields) {
      const row = await pull(ctx, repo, ref);
      const out: Record<string, unknown> = {};
      for (const field of fields) {
        if (field !== 'files') out[field] = restPullField(row, field);
      }
      if (fields.includes('files')) {
        const files: Array<{ path: string; additions: number; deletions: number }> = [];
        // GitHub caps the listing at 3000 files (30 pages of 100).
        for (let page = 1; page <= 30; page += 1) {
          const rows = await request<
            Array<{ filename: string; additions?: number; deletions?: number }>
          >(
            ctx,
            repo,
            'GET',
            `/repos/${repo.slug}/pulls/${row.number}/files?per_page=100&page=${page}`
          );
          for (const file of rows)
            files.push({
              path: file.filename,
              additions: file.additions ?? 0,
              deletions: file.deletions ?? 0,
            });
          if (rows.length < 100) break;
        }
        out.files = files;
      }
      return out;
    },
    async githubApiGet(ctx, repo, path) {
      return request<unknown>(ctx, repo, 'GET', `/repos/${repo.slug}${path ? `/${path}` : ''}`);
    },
    async prMerge(ctx, repo, input) {
      const row = await request<{ merged?: boolean }>(
        ctx,
        repo,
        'PUT',
        `/repos/${repo.slug}/pulls/${input.number}/merge`,
        { merge_method: input.method, sha: input.expectedHeadSha }
      );
      if (row.merged !== true) throw new VcsHostError('conflict', 'GitHub did not merge the PR');
      if (input.deleteBranch) {
        try {
          // Only a same-repository head may be deleted: a fork's branch name
          // must never select a same-named branch in the base repository.
          const merged = await request<RestPull>(
            ctx,
            repo,
            'GET',
            `/repos/${repo.slug}/pulls/${input.number}`
          );
          if (merged.head.repo?.full_name !== repo.slug || merged.head.ref !== input.headRefName)
            return { number: input.number, merged: true };
          await request(
            ctx,
            repo,
            'DELETE',
            `/repos/${repo.slug}/git/refs/heads/${input.headRefName
              .split('/')
              .map(encodeURIComponent)
              .join('/')}`
          );
        } catch {
          // The merge succeeded; a fork head or protected branch is not deletable.
        }
      }
      return { number: input.number, merged: true };
    },
  };
}

export const githubRestVcsHostProvider = createGithubRestVcsHostProvider();

registerVcsHostProvider(githubRestVcsHostProvider, {
  provenance: 'builtin',
  source: 'libs/core/vcs/github-rest-host-provider.ts',
});

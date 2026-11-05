/**
 * gh-cli vcs-host provider — the governed default. Transport only: every call
 * is one fixed `gh` argv over the injected runner (default `safeExecResult`).
 * Argument hygiene, admission, snapshot binding and sanitization live in the
 * verb layer (`vcs-host.ts`). The argv mirrors the sync `github.ts` verbs, so
 * selecting `gh-cli` reproduces their host-side behaviour, including
 * `--match-head-commit` on merge.
 *
 * Importing this module installs `gh-cli` on the vcs-host seam.
 */

import { safeExecResult } from '../secure-io.js';
import type { VcsCommandResult, VcsCommandRunner } from './vcs-backend.js';
import type { PrCheckEntry, PrListEntry } from './github.js';
import {
  GH_CLI_VCS_HOST_ID,
  registerVcsHostProvider,
  VcsHostError,
  type VcsHostCallContext,
  type VcsHostErrorCode,
  type VcsHostProvider,
  type VcsPullRequestSnapshot,
  type VcsRepositoryRef,
} from './vcs-host.js';

const PR_QUEUE_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){mergeQueueEntry{id}}}}';
const PR_VIEW_FIELDS =
  'number,url,headRefOid,baseRefOid,baseRefName,headRefName,state,title,isDraft';

function classify(result: VcsCommandResult): VcsHostErrorCode {
  const text = `${result.stderr}\n${result.stdout}\n${result.error?.message ?? ''}`;
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return 'unavailable';
  if (/HTTP 401|Bad credentials|not logged in|authentication/i.test(text)) return 'auth';
  if (/HTTP 403|forbidden|permission/i.test(text)) return 'forbidden';
  if (/HTTP 404|not found|could not resolve/i.test(text)) return 'not_found';
  if (/head commit|match-head-commit|HTTP 409/i.test(text)) return 'stale_head';
  if (/not mergeable|merge conflict|HTTP 405/i.test(text)) return 'conflict';
  if (/rate limit|HTTP 429/i.test(text)) return 'rate_limited';
  if (/unknown flag|invalid|HTTP 422/i.test(text)) return 'invalid';
  return 'unavailable';
}

export function createGhCliVcsHostProvider(
  options: { run?: VcsCommandRunner } = {}
): VcsHostProvider {
  // Resolve the default lazily so a test double installed on secure-io is honoured.
  // The default runner only ever launches the external `gh` binary: the literal
  // command keeps it out of the role-assumption analysis' "child may run
  // Kyberion code under the inherited SYSTEM_ROLE" set.
  const run: VcsCommandRunner =
    options.run ?? ((_command, args, opts) => safeExecResult('gh', args, opts));
  // Only a positive probe is cached: a gh installed later in the process is picked up.
  let available = false;

  const execOptions = (ctx: VcsHostCallContext) => ({
    cwd: ctx.cwd,
    ...(Object.keys(ctx.env).length > 0 ? { env: ctx.env } : {}),
    ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}),
  });
  const gh = (ctx: VcsHostCallContext, args: string[], label: string): string => {
    const result = run('gh', args, execOptions(ctx));
    if (result.error || result.status !== 0)
      throw new VcsHostError(classify(result), `gh ${label} failed`);
    return result.stdout;
  };
  const json = <T>(ctx: VcsHostCallContext, args: string[], label: string): T => {
    const stdout = gh(ctx, args, label);
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new VcsHostError('invalid', `gh ${label}: invalid JSON`);
    }
  };
  const api = <T>(ctx: VcsHostCallContext, repo: VcsRepositoryRef, path: string): T =>
    json<T>(ctx, ['api', `repos/${repo.slug}${path}`, '--hostname', repo.host], 'api');

  return {
    id: GH_CLI_VCS_HOST_ID,
    isAvailable() {
      if (!available) {
        const result = run('gh', ['--version'], {});
        available = !result.error && result.status === 0;
      }
      return available;
    },
    async authStatus(ctx) {
      const result = run('gh', ['auth', 'status'], execOptions(ctx));
      return { ok: !result.error && result.status === 0, detail: classify(result) };
    },
    async repository(ctx) {
      const row = json<{ nameWithOwner?: string; url?: string }>(
        ctx,
        ['repo', 'view', '--json', 'nameWithOwner,url'],
        'repo view'
      );
      const url = new URL(String(row.url));
      return { slug: String(row.nameWithOwner), url: url.toString(), host: url.host };
    },
    async defaultBranch(ctx, repo) {
      const row = json<{ defaultBranchRef?: { name?: string } }>(
        ctx,
        ['repo', 'view', repo.url, '--json', 'defaultBranchRef'],
        'repo view'
      );
      return String(row.defaultBranchRef?.name ?? '');
    },
    async visibility(ctx, repo) {
      const info = api<{ private?: boolean; visibility?: string }>(ctx, repo, '');
      if (info.private === true || info.visibility === 'private') return 'private';
      if (info.visibility === 'internal') return 'internal';
      if (info.visibility === 'public' || info.private === false) return 'public';
      return 'unknown';
    },
    async commitSha(ctx, repo, ref) {
      return String(
        api<{ sha?: string }>(ctx, repo, `/commits/${encodeURIComponent(ref)}`).sha ?? ''
      );
    },
    async prView(ctx, repo, ref) {
      const row = json<Partial<VcsPullRequestSnapshot>>(
        ctx,
        ['pr', 'view', ref, '--repo', repo.url, '--json', PR_VIEW_FIELDS],
        'pr view'
      );
      return {
        number: Number(row.number),
        url: String(row.url),
        headRefOid: String(row.headRefOid),
        baseRefOid: String(row.baseRefOid),
        headRefName: String(row.headRefName),
        baseRefName: String(row.baseRefName),
        state: String(row.state),
        title: String(row.title ?? ''),
        isDraft: row.isDraft === true,
      };
    },
    async prList(ctx, repo, filter) {
      return json<PrListEntry[]>(
        ctx,
        [
          'pr',
          'list',
          '--repo',
          repo.url,
          '--state',
          filter.state,
          '--limit',
          String(filter.limit),
          '--json',
          'number,title,headRefOid,headRefName,isDraft,author,state',
          ...(filter.head ? ['--head', filter.head] : []),
        ],
        'pr list'
      );
    },
    async prChecks(ctx, repo, ref) {
      // gh exits non-zero while a check is pending/failed; the JSON is still valid.
      const result = run(
        'gh',
        ['pr', 'checks', ref, '--repo', repo.url, '--json', 'name,state,bucket,link'],
        execOptions(ctx)
      );
      const raw = (result.stdout || '').trim();
      if (!raw) {
        if (result.error || (result.status ?? 0) !== 0)
          throw new VcsHostError(classify(result), 'gh pr checks failed');
        return [];
      }
      try {
        return JSON.parse(raw) as PrCheckEntry[];
      } catch {
        throw new VcsHostError('invalid', 'gh pr checks: invalid JSON');
      }
    },
    async prQueued(ctx, repo, number) {
      const [owner, name] = repo.slug.split('/');
      const row = json<{
        errors?: unknown;
        data?: { repository?: { pullRequest?: { mergeQueueEntry: unknown } } };
      }>(
        ctx,
        [
          'api',
          'graphql',
          '--hostname',
          repo.host,
          '-f',
          `query=${PR_QUEUE_QUERY}`,
          '-f',
          `owner=${owner}`,
          '-f',
          `name=${name}`,
          '-F',
          `number=${number}`,
        ],
        'api graphql'
      );
      if (row.errors || !row.data?.repository?.pullRequest)
        throw new VcsHostError('unavailable', 'Cannot verify server merge queue');
      return Boolean(row.data.repository.pullRequest.mergeQueueEntry);
    },
    async prCreate(ctx, repo, input) {
      const args = [
        'pr',
        'create',
        '--repo',
        repo.url,
        '--title',
        input.title,
        '--body',
        input.body,
        '--base',
        input.base,
        '--head',
        input.head,
      ];
      if (input.draft) args.push('--draft');
      const url = gh(ctx, args, 'pr create').trim().split('\n').pop() ?? '';
      const number = Number(url.match(/\/pull\/(\d+)$/)?.[1]);
      if (!Number.isInteger(number))
        throw new VcsHostError('invalid', 'gh pr create: no pull request URL in output');
      return { number, url };
    },
    async prFields(ctx, repo, ref, fields) {
      return json<Record<string, unknown>>(
        ctx,
        ['pr', 'view', ref, '--repo', repo.url, '--json', fields.join(',')],
        'pr view'
      );
    },
    async githubApiGet(ctx, repo, path) {
      return api<unknown>(ctx, repo, path ? `/${path}` : '');
    },
    async prMerge(ctx, repo, input) {
      const args = [
        'pr',
        'merge',
        String(input.number),
        '--repo',
        repo.url,
        `--${input.method}`,
        '--match-head-commit',
        input.expectedHeadSha,
      ];
      if (input.deleteBranch) args.push('--delete-branch');
      gh(ctx, args, 'pr merge');
      return { number: input.number, merged: true };
    },
  };
}

export const ghCliVcsHostProvider = createGhCliVcsHostProvider();

registerVcsHostProvider(ghCliVcsHostProvider, {
  provenance: 'builtin',
  source: 'libs/core/vcs/gh-cli-host-provider.ts',
});

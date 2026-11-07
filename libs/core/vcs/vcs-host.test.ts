import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  admitError: undefined as Error | undefined,
  admitted: [] as Array<{
    operationId: string;
    effect: Record<string, unknown>;
    requiresApproval: boolean;
  }>,
}));
vi.mock('./cwd-scope.js', () => ({ assertVcsCwdScope: vi.fn() }));
vi.mock('../governance/external-operation.js', () => ({
  runExternalOperation: async (
    input: (typeof mocks.admitted)[number],
    execute: () => Promise<unknown>
  ) => {
    mocks.admitted.push(input);
    if (mocks.admitError && input.requiresApproval) throw mocks.admitError;
    return execute();
  },
  runExternalOperationSync: (input: (typeof mocks.admitted)[number], execute: () => unknown) => {
    mocks.admitted.push(input);
    return execute();
  },
}));

import type { VcsCommandRunner } from './vcs-backend.js';
import { ghPrCreate, ghPrMerge } from './github.js';
import {
  GH_CLI_VCS_HOST_ID,
  GITHUB_REST_VCS_HOST_ID,
  getVcsHostProvider,
  listVcsHostProviders,
  registerVcsHostProvider,
  resolveVcsHostProvider,
  vcsHostCallContext,
  VcsHostError,
  type VcsHostCallContext,
  type VcsHostProvider,
} from './vcs-host.js';
import {
  summarizePrChecks,
  vcsHostAuthStatus,
  vcsHostPrChecks,
  vcsHostPrChecksWait,
  vcsHostPrCreate,
  vcsHostPrList,
  vcsHostPrMerge,
  vcsHostPrView,
} from './vcs-host-verbs.js';
import { createGhCliVcsHostProvider, failureDetail } from './gh-cli-host-provider.js';
import {
  checkRunBucket,
  createGithubRestVcsHostProvider,
  parseGithubRemote,
  type GithubRestFetch,
} from './github-rest-host-provider.js';
import { createMemoryVcsHostProvider } from './memory-vcs-host-provider.js';
import { parseVcsPrFields } from './vcs-host.js';
import {
  vcsHostGithubApiGet,
  vcsHostPrViewFields,
  vcsHostOptionsForRunner,
  vcsHostRepositoryVisibility,
} from './vcs-host-verbs.js';
import { vcsDefaultRunner } from './vcs-backend.js';
import { restPullField } from './github-rest-host-provider.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const REPO = { slug: 'acme/widgets', url: 'https://github.com/acme/widgets', host: 'github.com' };

/** One fixture forge, exposed both as gh CLI output and as REST JSON. */
const PULL = {
  number: 7,
  html_url: 'https://github.com/acme/widgets/pull/7',
  title: 'Add widget',
  state: 'open' as const,
  draft: false,
  merged_at: null,
  user: { login: 'octo' },
  head: { sha: HEAD, ref: 'feat/widget', repo: { full_name: 'acme/widgets' } },
  base: { sha: BASE, ref: 'main' },
};

function ghFixtureRunner(calls: string[][] = []): VcsCommandRunner {
  return (bin, args) => {
    calls.push([bin, ...args]);
    const ok = (value: unknown) => ({
      stdout: typeof value === 'string' ? value : JSON.stringify(value),
      stderr: '',
      status: 0,
    });
    if (bin === 'git') {
      if (args[0] === 'symbolic-ref') return ok('feat/widget');
      if (args[0] === 'rev-parse') return ok(HEAD);
      if (args[0] === 'remote') return ok('git@github.com:acme/widgets.git');
    }
    const joined = args.join(' ');
    if (joined === '--version') return ok('gh version 2.60.0');
    if (joined.startsWith('repo view --json nameWithOwner,url'))
      return ok({ nameWithOwner: REPO.slug, url: REPO.url });
    if (joined.startsWith('repo view')) return ok({ defaultBranchRef: { name: 'main' } });
    if (args[0] === 'api' && args[1] === 'repos/acme/widgets')
      return ok({ private: true, visibility: 'private' });
    if (args[0] === 'api' && args[1].startsWith('repos/acme/widgets/commits/'))
      return ok({ sha: args[1].endsWith('main') ? BASE : HEAD });
    if (joined.startsWith('pr view')) {
      const fields = args[args.indexOf('--json') + 1].split(',');
      const row: Record<string, unknown> = {
        number: 7,
        url: PULL.html_url,
        headRefOid: HEAD,
        baseRefOid: BASE,
        headRefName: 'feat/widget',
        baseRefName: 'main',
        state: 'OPEN',
        title: 'Add widget',
        isDraft: false,
        author: { login: 'octo' },
        mergedAt: null,
        closedAt: null,
        mergeCommit: null,
        files: [{ path: 'src/widget.ts', additions: 3, deletions: 1 }],
      };
      // Real gh returns only the requested --json fields.
      return ok(Object.fromEntries(fields.map((field) => [field, row[field]])));
    }
    if (joined.startsWith('pr list'))
      return ok([
        {
          number: 7,
          title: 'Add widget',
          headRefOid: HEAD,
          headRefName: 'feat/widget',
          isDraft: false,
          author: { login: 'octo' },
          state: 'OPEN',
        },
      ]);
    if (joined.startsWith('pr checks'))
      return {
        ...ok([
          { name: 'build', state: 'SUCCESS', bucket: 'pass', link: 'https://ci/1' },
          { name: 'lint', state: 'PENDING', bucket: 'pending', link: 'https://ci/2' },
        ]),
        status: 8,
      };
    if (joined.startsWith('pr create')) return ok('https://github.com/acme/widgets/pull/8\n');
    if (joined.startsWith('pr merge')) return ok('');
    return { stdout: '', stderr: `unexpected ${joined}`, status: 1 };
  };
}

function restFixtureFetch(calls: Array<Record<string, unknown>> = []): GithubRestFetch {
  return (async (request: Record<string, unknown>) => {
    calls.push(request);
    const url = String(request.url).replace('https://api.github.com', '');
    if (url === '/repos/acme/widgets')
      return { default_branch: 'main', private: true, visibility: 'private' };
    if (
      url.startsWith('/repos/acme/widgets/commits/') &&
      url.endsWith('/check-runs?per_page=100&filter=latest')
    )
      return {
        check_runs: [
          { name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://ci/1' },
        ],
      };
    if (url.endsWith('/status'))
      return {
        statuses: [{ context: 'lint', state: 'pending', target_url: 'https://ci/2' }],
      };
    if (url.startsWith('/repos/acme/widgets/commits/'))
      return { sha: url.endsWith('/main') ? BASE : HEAD };
    if (url === '/repos/acme/widgets/pulls/7') return PULL;
    if (url === '/repos/acme/widgets/pulls/7/files?per_page=100&page=1')
      return [{ filename: 'src/widget.ts', additions: 3, deletions: 1 }];
    if (url.startsWith('/repos/acme/widgets/pulls?')) return [PULL];
    if (url === '/repos/acme/widgets/pulls' && request.method === 'POST')
      return { number: 8, html_url: 'https://github.com/acme/widgets/pull/8' };
    if (url === '/repos/acme/widgets/pulls/7/merge') return { merged: true };
    if (url === '/user') return { login: 'octo' };
    if (request.method === 'DELETE') return {};
    throw Object.assign(new Error(`unexpected ${url}`), { httpStatus: 404 });
  }) as GithubRestFetch;
}

function ctx(overrides: Partial<VcsHostCallContext> = {}): VcsHostCallContext {
  return {
    env: { GH_TOKEN: 'ghp_fixturetoken000000000000' },
    git: ghFixtureRunner(),
    ...overrides,
  };
}

beforeEach(() => {
  mocks.admitted.length = 0;
});

describe('vcs-host provider contract (gh-cli ≡ github-rest)', () => {
  const providers: Array<[string, () => VcsHostProvider]> = [
    ['gh-cli', () => createGhCliVcsHostProvider({ run: ghFixtureRunner() })],
    ['github-rest', () => createGithubRestVcsHostProvider({ fetch: restFixtureFetch() })],
  ];
  const results = new Map<string, unknown>();

  it.each(providers)('%s normalizes the same forge facts', async (id, make) => {
    const provider = make();
    const c = ctx();
    const repo = await provider.repository(c);
    const facts = {
      repo,
      defaultBranch: await provider.defaultBranch(c, repo),
      visibility: await provider.visibility(c, repo),
      head: await provider.commitSha(c, repo, 'feat/widget'),
      base: await provider.commitSha(c, repo, 'main'),
      view: await provider.prView(c, repo, '7'),
      list: await provider.prList(c, repo, { state: 'open', limit: 10 }),
      checks: summarizePrChecks(await provider.prChecks(c, repo, '7')),
      fields: await provider.prFields(c, repo, '7', [
        'number',
        'state',
        'author',
        'mergedAt',
        'closedAt',
        'mergeCommit',
        'files',
      ]),
    };
    results.set(id, facts);
    expect(facts.repo).toEqual(REPO);
    expect(facts.view.headRefOid).toBe(HEAD);
    expect(facts.checks.state).toBe('pending');
  });

  it('both providers produce identical normalized results', () => {
    expect(results.get('gh-cli')).toEqual(results.get('github-rest'));
  });
});

describe('vcs-host resolution', () => {
  it('installs gh-cli and github-rest as builtins, never memory', () => {
    const ids = listVcsHostProviders().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([GH_CLI_VCS_HOST_ID, GITHUB_REST_VCS_HOST_ID]));
    expect(ids).not.toContain('memory');
  });

  it('rejects an unknown explicit provider', () => {
    expect(() => resolveVcsHostProvider({ provider: 'nope' })).toThrow(/VCS_HOST_UNAVAILABLE/);
  });

  it('skips unavailable providers in chain order and fails closed when none is available', () => {
    const gh = getVcsHostProvider(GH_CLI_VCS_HOST_ID)!;
    const rest = getVcsHostProvider(GITHUB_REST_VCS_HOST_ID)!;
    const ghSpy = vi.spyOn(gh, 'isAvailable').mockReturnValue(false);
    try {
      expect(resolveVcsHostProvider({}, ctx()).id).toBe(GITHUB_REST_VCS_HOST_ID);
      expect(() => resolveVcsHostProvider({}, ctx({ env: {} }))).toThrow(/VCS_HOST_UNAVAILABLE/);
      expect(rest.isAvailable(ctx({ env: {} }))).toBe(false);
    } finally {
      ghSpy.mockRestore();
    }
  });

  it('builds credentials from registered env plus explicit overrides', () => {
    const built = vcsHostCallContext({ env: { GH_TOKEN: 'override' } });
    expect(built.env.GH_TOKEN).toBe('override');
  });
});

describe('governed vcs-host verbs', () => {
  let unregister: (() => void) | undefined;
  afterEach(() => unregister?.());

  function memory() {
    const forge = createMemoryVcsHostProvider({
      id: 'memory-test',
      repository: REPO,
      branches: { 'feat/widget': HEAD, main: BASE },
      pulls: [
        {
          number: 7,
          url: PULL.html_url,
          headRefOid: HEAD,
          baseRefOid: BASE,
          headRefName: 'feat/widget',
          baseRefName: 'main',
          state: 'OPEN',
          title: 'Add widget',
          isDraft: false,
          checks: [
            { name: 'build', bucket: 'pass' },
            { name: 'flaky', bucket: 'fail' },
          ],
        },
      ],
    });
    unregister = registerVcsHostProvider(forge);
    return forge;
  }
  const opts = { provider: 'memory-test', git: ghFixtureRunner() };

  it('pr create effect is identical to the sync gh path (same approval hash)', async () => {
    const forge = memory();
    const created = await vcsHostPrCreate({ ...opts, title: ' Add widget ', body: 'Body' });
    expect(created).toEqual({ number: 8, url: 'https://github.com/acme/widgets/pull/8' });
    expect(forge.created[0]).toMatchObject({
      head: 'feat/widget',
      base: 'main',
      title: 'Add widget',
    });
    const asyncEffect = mocks.admitted.find((a) => a.operationId === 'vcs:pr_create')!;
    expect(asyncEffect.requiresApproval).toBe(true);

    mocks.admitted.length = 0;
    ghPrCreate({ title: ' Add widget ', body: 'Body' }, ghFixtureRunner());
    const syncEffect = mocks.admitted.find((a) => a.operationId === 'vcs:pr_create')!;
    expect(asyncEffect.effect).toEqual(syncEffect.effect);
  });

  it('pr merge effect matches the sync path and binds the approved head', async () => {
    const forge = memory();
    await vcsHostPrMerge({ ...opts, ref: '7' });
    const asyncEffect = mocks.admitted.find((a) => a.operationId === 'vcs:pr_merge')!;
    expect(forge.merges[0]).toMatchObject({ number: 7, expectedHeadSha: HEAD, method: 'merge' });

    mocks.admitted.length = 0;
    ghPrMerge({ ref: '7' }, ghFixtureRunner());
    const syncEffect = mocks.admitted.find((a) => a.operationId === 'vcs:pr_merge')!;
    expect(asyncEffect.effect).toEqual(syncEffect.effect);
  });

  it('refuses a merge when the PR moves between approval and execution', async () => {
    const forge = memory();
    let reads = 0;
    const original = forge.prView.bind(forge);
    forge.prView = async (...args) => {
      const view = await original(...args);
      reads += 1;
      return reads > 1 ? { ...view, headRefOid: 'c'.repeat(40) } : view;
    };
    await expect(vcsHostPrMerge({ ...opts, ref: '7' })).rejects.toThrow(/VCS_SNAPSHOT_CHANGED/);
    expect(forge.merges).toHaveLength(0);
  });

  it('refuses a stale promotion revision before admission', async () => {
    memory();
    await expect(
      vcsHostPrMerge({ ...opts, ref: '7', expectedHeadSha: 'd'.repeat(40) })
    ).rejects.toThrow(/VCS_REVIEW_STALE/);
    expect(mocks.admitted.some((a) => a.operationId === 'vcs:pr_merge')).toBe(false);
  });

  it('refuses pr create when the pushed head differs from the local commit', async () => {
    const forge = memory();
    forge.state.branches['feat/widget'] = 'e'.repeat(40);
    await expect(vcsHostPrCreate({ ...opts, title: 'x' })).rejects.toThrow(
      /VCS_SNAPSHOT_UNAVAILABLE/
    );
  });

  it('reads are admitted as vcs:github:read without approval', async () => {
    memory();
    const view = await vcsHostPrView({ ...opts, ref: '7' });
    const list = await vcsHostPrList({ ...opts, state: 'open' });
    const checks = await vcsHostPrChecks({ ...opts, ref: '7', ignore: ['flaky'] });
    expect(view.number).toBe(7);
    expect(list).toHaveLength(1);
    expect(checks.state).toBe('success');
    expect(
      mocks.admitted.every((a) => a.operationId === 'vcs:github:read' && !a.requiresApproval)
    ).toBe(true);
    expect(mocks.admitted.some((a) => JSON.stringify(a.effect).includes('memory-test'))).toBe(
      false
    );
  });

  it('rejects flag-like refs before any provider call', async () => {
    memory();
    await expect(vcsHostPrView({ ...opts, ref: '--web' })).rejects.toThrow();
    expect(mocks.admitted).toHaveLength(0);
  });

  it('keeps governance errors from admission intact (class and identity)', async () => {
    memory();
    class ApprovalRequired extends Error {}
    const pending = new ApprovalRequired('approval pending');
    mocks.admitError = pending;
    try {
      await expect(vcsHostPrMerge({ ...opts, ref: '7' })).rejects.toBe(pending);
    } finally {
      mocks.admitError = undefined;
    }
  });

  it('sanitizes provider error text', async () => {
    const forge = memory();
    forge.prView = async () => {
      throw new VcsHostError('auth', 'token=ghp_leakedtoken1234567890 rejected');
    };
    const error = await vcsHostPrView({ ...opts, ref: '7' }).catch((e: Error) => e);
    expect(String(error)).not.toContain('ghp_leakedtoken');
    expect(error).toBeInstanceOf(VcsHostError);
    expect((error as VcsHostError).code).toBe('auth');
  });

  it('waits for checks to reach a terminal state', async () => {
    const forge = memory();
    const pull = forge.state.pulls[0];
    pull.checks = [{ name: 'build', bucket: 'pending' }];
    let sleeps = 0;
    const result = await vcsHostPrChecksWait({ ...opts, ref: '7', intervalMs: 1000 }, async () => {
      sleeps += 1;
      pull.checks = [{ name: 'build', bucket: 'pass' }];
    });
    expect(sleeps).toBe(1);
    expect(result).toMatchObject({ state: 'success', timed_out: false });
  });

  it('times out fail-closed with the last observed pending state', async () => {
    const forge = memory();
    forge.state.pulls[0].checks = [{ name: 'build', bucket: 'pending' }];
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const result = await vcsHostPrChecksWait(
        { ...opts, ref: '7', intervalMs: 1000, timeoutMs: 5000 },
        async (ms) => {
          vi.setSystemTime(Date.now() + Math.max(ms, 1000));
        }
      );
      expect(result).toMatchObject({ state: 'pending', timed_out: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the wait after consecutive provider failures', async () => {
    const forge = memory();
    forge.prChecks = async () => {
      throw new VcsHostError('unavailable', 'down');
    };
    await expect(
      vcsHostPrChecksWait({ ...opts, ref: '7', intervalMs: 1000 }, async () => undefined)
    ).rejects.toThrow(/VCS_GH_WAIT_FAILED/);
  });

  it('prefers an injected provider instance over seam resolution', async () => {
    const injected = createMemoryVcsHostProvider({ id: 'injected', repository: REPO });
    expect(resolveVcsHostProvider({ hostProvider: injected, provider: 'gh-cli' })).toBe(injected);
  });

  it('reports auth status per provider', async () => {
    memory();
    await expect(vcsHostAuthStatus(opts)).resolves.toMatchObject({
      provider: 'memory-test',
      ok: true,
    });
  });
});

describe('pr fields and GitHub API reads', () => {
  let unregister: (() => void) | undefined;
  afterEach(() => unregister?.());
  const opts = { provider: 'memory-fields', git: ghFixtureRunner() };
  function forge() {
    const provider = createMemoryVcsHostProvider({
      id: 'memory-fields',
      repository: REPO,
      pulls: [
        {
          number: 7,
          url: PULL.html_url,
          headRefOid: HEAD,
          baseRefOid: BASE,
          headRefName: 'feat/widget',
          baseRefName: 'main',
          state: 'MERGED',
          title: 'Add widget',
          isDraft: false,
          fields: { mergedAt: '2026-11-05T00:00:00Z', files: [{ path: 'a', additions: 1 }] },
        },
      ],
      api: { 'branches/main/protection/required_status_checks': { strict: true } },
    });
    unregister = registerVcsHostProvider(provider);
    return provider;
  }

  it('rejects unknown gh field names before any provider call', async () => {
    forge();
    expect(() => parseVcsPrFields('number,reviewDecision')).toThrow(/unsupported PR field/);
    await expect(
      vcsHostPrViewFields({ ...opts, ref: '7', fields: 'statusCheckRollup' })
    ).rejects.toThrow(/unsupported PR field/);
    expect(mocks.admitted).toHaveLength(0);
  });

  it('serves gh-shaped fields through the governed read', async () => {
    forge();
    await expect(
      vcsHostPrViewFields({ ...opts, ref: '7', fields: 'state,mergedAt,files' })
    ).resolves.toEqual({
      state: 'MERGED',
      mergedAt: '2026-11-05T00:00:00Z',
      files: [{ path: 'a', additions: 1 }],
    });
  });

  it('admits only allowlisted GitHub API read paths', async () => {
    forge();
    for (const path of [
      'hooks',
      'collaborators',
      'git/refs/heads/main',
      'commits/../../hooks?x',
      'commits/../../hooks',
      'commits/%2e%2e/%2e%2e/hooks',
      'commits/./main',
    ])
      await expect(vcsHostGithubApiGet({ ...opts, path })).rejects.toThrow(
        /VCS_TYPED_VERB_REQUIRED/
      );
    await expect(
      vcsHostGithubApiGet({ ...opts, path: 'branches/main/protection/required_status_checks' })
    ).resolves.toEqual({ strict: true });
  });

  it('treats a missing policy as absent only when allowed', async () => {
    forge();
    await expect(
      vcsHostGithubApiGet({ ...opts, path: 'rules/branches/main', allowMissing: true })
    ).resolves.toBeNull();
    await expect(vcsHostGithubApiGet({ ...opts, path: 'rules/branches/main' })).rejects.toThrow(
      VcsHostError
    );
  });

  it('exposes a REST merge commit only once the PR is merged (gh semantics)', () => {
    const open = { ...PULL, merge_commit_sha: 'f'.repeat(40) };
    expect(restPullField(open, 'mergeCommit')).toBeNull();
    expect(
      restPullField({ ...open, merged_at: '2026-11-05T00:00:00Z', state: 'closed' }, 'mergeCommit')
    ).toEqual({ oid: 'f'.repeat(40) });
    expect(
      restPullField({ ...open, merged_at: '2026-11-05T00:00:00Z', state: 'closed' }, 'state')
    ).toBe('MERGED');
  });
});

describe('github-rest provider specifics', () => {
  it('sends the token only as a bearer header and the approved head as merge sha', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider = createGithubRestVcsHostProvider({ fetch: restFixtureFetch(calls) });
    await provider.prMerge(ctx(), REPO, {
      number: 7,
      method: 'squash',
      deleteBranch: true,
      expectedHeadSha: HEAD,
      headRefName: 'feat/widget',
    });
    const merge = calls.find((c) => String(c.url).endsWith('/pulls/7/merge'))!;
    expect(merge).toMatchObject({ method: 'PUT', data: { merge_method: 'squash', sha: HEAD } });
    for (const call of calls) {
      expect(String(call.url)).not.toContain('ghp_');
      expect((call.headers as Record<string, string>).Authorization).toBe(
        'Bearer ghp_fixturetoken000000000000'
      );
    }
    expect(
      calls.some(
        (c) => c.method === 'DELETE' && String(c.url).endsWith('/git/refs/heads/feat/widget')
      )
    ).toBe(true);
  });

  it('never deletes a fork head branch in the base repository', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const base = restFixtureFetch(calls);
    const fetch = (async (request: Record<string, unknown>) => {
      if (String(request.url).endsWith('/pulls/7') && request.method === 'GET') {
        calls.push(request);
        return { ...PULL, head: { ...PULL.head, repo: { full_name: 'fork/widgets' } } };
      }
      return base(request as never);
    }) as GithubRestFetch;
    const provider = createGithubRestVcsHostProvider({ fetch });
    await provider.prMerge(ctx(), REPO, {
      number: 7,
      method: 'merge',
      deleteBranch: true,
      expectedHeadSha: HEAD,
      headRefName: 'feat/widget',
    });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('maps a moved head (409) on merge to stale_head', async () => {
    const provider = createGithubRestVcsHostProvider({
      fetch: (async () => {
        throw Object.assign(new Error('conflict'), { httpStatus: 409 });
      }) as GithubRestFetch,
    });
    const error = await provider
      .prMerge(ctx(), REPO, {
        number: 7,
        method: 'merge',
        deleteBranch: false,
        expectedHeadSha: HEAD,
        headRefName: 'feat/widget',
      })
      .catch((e: VcsHostError) => e);
    expect(error).toBeInstanceOf(VcsHostError);
    expect((error as VcsHostError).code).toBe('stale_head');
  });

  it('routes Enterprise hosts to /api/v3', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider = createGithubRestVcsHostProvider({
      fetch: (async (request: Record<string, unknown>) => {
        calls.push(request);
        return { default_branch: 'trunk' };
      }) as GithubRestFetch,
    });
    const ghe = {
      slug: 'acme/widgets',
      url: 'https://ghe.example.com/acme/widgets',
      host: 'ghe.example.com',
    };
    await expect(provider.defaultBranch(ctx(), ghe)).resolves.toBe('trunk');
    expect(calls[0].url).toBe('https://ghe.example.com/api/v3/repos/acme/widgets');
  });

  it('parses https, ssh and scp-like origin remotes to the canonical ref', () => {
    for (const remote of [
      'https://github.com/acme/widgets.git',
      'ssh://git@github.com/acme/widgets.git',
      'git@github.com:acme/widgets.git',
      'https://github.com/acme/widgets/',
    ])
      expect(parseGithubRemote(remote)).toEqual(REPO);
    expect(() => parseGithubRemote('file:///tmp/repo')).toThrow(VcsHostError);
    expect(() => parseGithubRemote('https://github.com/acme')).toThrow(VcsHostError);
  });

  it('maps check-run conclusions to gh buckets', () => {
    expect(checkRunBucket('queued', null)).toBe('pending');
    expect(checkRunBucket('completed', 'success')).toBe('pass');
    expect(checkRunBucket('completed', 'neutral')).toBe('pass');
    expect(checkRunBucket('completed', 'skipped')).toBe('skipping');
    expect(checkRunBucket('completed', 'cancelled')).toBe('cancel');
    expect(checkRunBucket('completed', 'timed_out')).toBe('fail');
  });
});

describe('gh CLI failure detail', () => {
  it('keeps the first stderr line and redacts token-shaped values', () => {
    expect(
      failureDetail({
        status: 1,
        stdout: '',
        stderr: 'HTTP 502: Bad Gateway (token ghp_ABCDEFGHIJKLMNOP)\nmore lines',
      } as never)
    ).toBe(' — HTTP 502: Bad Gateway (token [redacted])');
    expect(failureDetail({ status: 1, stdout: '', stderr: '' } as never)).toBe('');
  });

  it('puts the detail on the thrown error', async () => {
    const provider = createGhCliVcsHostProvider({
      run: () => ({ status: 1, stdout: '', stderr: 'error connecting to api.github.com' }) as never,
    });
    await expect(provider.repository(ctx())).rejects.toThrow(
      'gh repo view failed — error connecting to api.github.com'
    );
  });
});

describe('repository visibility verb', () => {
  let unregister: (() => void) | undefined;
  afterEach(() => unregister?.());
  const repository = { host: 'github.com', slug: 'acme/widgets' };

  it('reads visibility through the selected provider without gh', async () => {
    const provider = createMemoryVcsHostProvider({
      id: 'memory-visibility',
      visibility: 'private',
    });
    unregister = registerVcsHostProvider(provider);
    await expect(
      vcsHostRepositoryVisibility({ provider: 'memory-visibility', repository })
    ).resolves.toBe('private');
  });

  it('is unknown for a missing or malformed repository, before any provider call', async () => {
    const visibility = vi.fn(async () => 'private' as const);
    const hostProvider = { ...createMemoryVcsHostProvider(), visibility };
    await expect(vcsHostRepositoryVisibility({ hostProvider })).resolves.toBe('unknown');
    await expect(
      vcsHostRepositoryVisibility({
        hostProvider,
        repository: { host: 'github.com', slug: '../x' },
      })
    ).resolves.toBe('unknown');
    await expect(
      vcsHostRepositoryVisibility({
        hostProvider,
        repository: { host: 'evil.test/github.com', slug: 'acme/widgets' },
      })
    ).resolves.toBe('unknown');
    expect(visibility).not.toHaveBeenCalled();
  });

  it('is unknown (not private) when the provider cannot verify it', async () => {
    const hostProvider = {
      ...createMemoryVcsHostProvider(),
      visibility: async () => {
        throw new VcsHostError('auth', 'no credentials');
      },
    };
    await expect(vcsHostRepositoryVisibility({ hostProvider, repository })).resolves.toBe(
      'unknown'
    );
  });

  it('injects gh-cli only over a caller-owned runner, never over the ambient defaults', () => {
    expect(vcsHostOptionsForRunner({ cwd: '/x' }, vcsDefaultRunner)).toEqual({ cwd: '/x' });
    expect(vcsHostOptionsForRunner({ cwd: '/x' })).toEqual({ cwd: '/x' });
    const run: VcsCommandRunner = () => ({ status: 0, stdout: '', stderr: '' });
    const injected = vcsHostOptionsForRunner({ cwd: '/x' }, run);
    expect(injected.git).toBe(run);
    expect(injected.hostProvider?.id).toBe('gh-cli');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  audit: vi.fn(),
  reserve: vi.fn(),
  body: 'reviewed body',
}));
vi.mock('../governance/approval-gate.js', () => ({ enforceApprovalGate: mocks.gate }));
vi.mock('../governance/audit-chain.js', () => ({ auditChain: { record: mocks.audit } }));
vi.mock('../governance/external-operation-store.js', () => ({
  reserveExternalOperation: mocks.reserve,
}));
vi.mock('../secure-io.js', async (original) => {
  const actual = await original<typeof import('../secure-io.js')>();
  return {
    ...actual,
    safeReadFile: (file: string, options?: Parameters<typeof actual.safeReadFile>[1]) =>
      file === '/fixture/body.md' ? mocks.body : actual.safeReadFile(file, options),
  };
});
import { gitRun, gitPush, gitFetch, gitStatus, type VcsCommandRunner } from './git.js';
import { ghPrCreate, ghPrMerge, ghPrView, ghRun, ghMust } from './github.js';
import { withExternalOperationAuthority } from '../governance/external-operation.js';

describe('canonical VCS external governance', () => {
  let sha = 'a'.repeat(40);
  let remote = 'https://github.com/owner/repo.git';
  let prSha = 'a'.repeat(40);
  let calls: Array<{ bin: string; args: string[] }>;
  let mutationStatus: number;
  const run: VcsCommandRunner = (bin, args) => {
    calls.push({ bin, args });
    let stdout = '';
    if (bin === 'git') {
      if (args[0] === 'remote') stdout = remote;
      else if (args[0] === 'rev-parse') stdout = sha;
      else if (args[0] === 'symbolic-ref') stdout = 'feature';
      else if (args[0] === 'push')
        return { status: mutationStatus, stdout: '', stderr: 'connection lost after send' };
    } else if (args[0] === 'repo')
      stdout = JSON.stringify({
        nameWithOwner: 'owner/repo',
        url: 'https://github.com/owner/repo',
      });
    else if (args[0] === 'api') stdout = JSON.stringify({ sha });
    else if (args[0] === 'pr' && args[1] === 'view')
      stdout = JSON.stringify({
        number: 7,
        url: 'https://github.com/owner/repo/pull/7',
        headRefOid: prSha,
        baseRefOid: 'c'.repeat(40),
      });
    else if (args[0] === 'pr' && ['create', 'merge'].includes(args[1]))
      return { status: mutationStatus, stdout: 'https://github.com/owner/repo/pull/7', stderr: '' };
    return { status: 0, stdout, stderr: '' };
  };
  const trusted = <T>(body: () => T) =>
    withExternalOperationAuthority(() => ({ agentId: 'owner', invocationId: 'invocation' }), body);
  const sent = () =>
    calls.filter(
      ({ args }) =>
        args[0] === 'push' || (args[0] === 'pr' && ['create', 'merge'].includes(args[1]))
    );
  beforeEach(() => {
    vi.clearAllMocks();
    calls = [];
    sha = 'a'.repeat(40);
    prSha = sha;
    remote = 'https://github.com/owner/repo.git';
    mutationStatus = 0;
    mocks.body = 'reviewed body';
    mocks.gate.mockReturnValue({ allowed: false, status: 'human_required' });
  });
  it('blocks direct canonical push/create/merge with no trusted authority', () => {
    expect(() => gitPush('/fixture', { ref: 'feature' }, run)).toThrow(
      'EXTERNAL_APPROVAL_REQUIRED'
    );
    expect(() =>
      ghPrCreate({ cwd: '/fixture', title: 'review', head: 'feature', base: 'main' }, run)
    ).toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(() => ghPrMerge({ cwd: '/fixture', ref: '7' }, run)).toThrow(
      'EXTERNAL_APPROVAL_REQUIRED'
    );
    expect(sent()).toEqual([]);
  });
  it('pins push to approved remote URL and commit SHA, then sets upstream locally', () => {
    mocks.gate.mockReturnValue({ allowed: true, status: 'approved' });
    trusted(() => gitPush('/fixture', { ref: 'feature', setUpstream: true }, run));
    expect(sent()[0].args).toEqual(['push', '--', remote, `${sha}:refs/heads/feature`]);
    expect(
      calls.some(({ args }) => args[0] === 'config' && args[1] === 'branch.feature.remote')
    ).toBe(true);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'succeeded' }) })
    );
  });
  it.each(['sha', 'remote'])('rejects changed push %s after approval before sending', (field) => {
    mocks.gate.mockImplementation(() => {
      if (field === 'sha') sha = 'b'.repeat(40);
      else remote = 'https://github.com/evil/repo.git';
      return { allowed: true, status: 'approved' };
    });
    expect(() => trusted(() => gitPush('/fixture', { ref: 'feature' }, run))).toThrow(
      'VCS_SNAPSHOT_CHANGED'
    );
    expect(sent()).toEqual([]);
  });
  it('captures body file in PR approval and sends immutable content to explicit repository', () => {
    mocks.gate.mockReturnValue({ allowed: true, status: 'approved' });
    trusted(() =>
      ghPrCreate(
        {
          cwd: '/fixture',
          title: 'review',
          head: 'feature',
          base: 'main',
          bodyFile: '/fixture/body.md',
        },
        run
      )
    );
    expect(sent()[0].args).toContain('reviewed body');
    expect(sent()[0].args).toContain('https://github.com/owner/repo');
    expect(sent()[0].args).not.toContain('--body-file');
  });
  it('rejects edited PR review body after approval', () => {
    mocks.gate.mockImplementation(() => {
      mocks.body = 'changed';
      return { allowed: true, status: 'approved' };
    });
    expect(() =>
      trusted(() =>
        ghPrCreate(
          { title: 'review', head: 'feature', base: 'main', bodyFile: '/fixture/body.md' },
          run
        )
      )
    ).toThrow('VCS_SNAPSHOT_CHANGED');
    expect(sent()).toEqual([]);
  });
  it('uses PR head commit compare-and-swap for merge', () => {
    mocks.gate.mockReturnValue({ allowed: true, status: 'approved' });
    trusted(() => ghPrMerge({ cwd: '/fixture', ref: '7' }, run));
    expect(sent()[0].args).toEqual(
      expect.arrayContaining([
        '--match-head-commit',
        prSha,
        '--repo',
        'https://github.com/owner/repo',
      ])
    );
  });
  it('rejects changed PR head before merge', () => {
    mocks.gate.mockImplementation(() => {
      prSha = 'b'.repeat(40);
      return { allowed: true, status: 'approved' };
    });
    expect(() => trusted(() => ghPrMerge({ ref: '7' }, run))).toThrow('VCS_SNAPSHOT_CHANGED');
    expect(sent()).toEqual([]);
  });
  it('never retries an ambiguous push and records unknown', () => {
    mocks.gate.mockReturnValue({ allowed: true, status: 'approved' });
    mutationStatus = 1;
    trusted(() => gitPush('/fixture', { ref: 'feature' }, run));
    expect(sent()).toHaveLength(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'unknown' }) })
    );
  });
  it('keeps network reads and local reads automatic and rejects raw mutation bypass', () => {
    gitFetch('/fixture', {}, run);
    gitStatus('/fixture', {}, run);
    ghPrView({ ref: '7' }, run);
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(() => ghRun(['pr', 'merge', '7'], {}, run)).toThrow('VCS_TYPED_VERB_REQUIRED');
    expect(() => ghMust(['pr', 'create', '--title', 'unsafe'], {}, run)).toThrow(
      'VCS_TYPED_VERB_REQUIRED'
    );
    expect(sent()).toEqual([]);
  });
  it.each([
    ['-C', '/fixture', 'push', 'origin', 'HEAD'],
    ['-c', 'remote.origin.url=https://example.test/repo', 'push'],
    ['send-email', 'HEAD'],
    ['remote', 'update'],
    ['custom-network-alias'],
  ])('rejects generic git network/global-option bypass %j', (...args) => {
    const transport = vi.fn();
    expect(() => gitRun(args, '/fixture', transport)).toThrow('VCS_TYPED_VERB_REQUIRED');
    expect(transport).not.toHaveBeenCalled();
  });
  it('does not reinterpret a tag ref as a branch publication target', () => {
    expect(() => gitPush('/fixture', { ref: 'refs/tags/v1' }, run)).toThrow('VCS_GIT_INVALID');
    expect(sent()).toEqual([]);
    expect(mocks.gate).not.toHaveBeenCalled();
  });
});

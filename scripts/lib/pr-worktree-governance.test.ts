import * as path from 'node:path';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeWriteFile, safeRmSync } from '@agent/core/secure-io';
import type { GitRunner } from '@agent/core/knowledge/memory-promotion-git';

const mocks = vi.hoisted(() => ({ local: vi.fn(), body: vi.fn(() => 'protected PR text') }));
vi.mock('@agent/core/vcs/publication-host', () => ({ runVcsMutationWithApproval: mocks.local }));
vi.mock('@agent/core/secure-io', async (original) => {
  const actual = await original<typeof import('@agent/core/secure-io')>();
  return {
    ...actual,
    safeReadFile: (file: string, options?: Parameters<typeof actual.safeReadFile>[1]) =>
      String(file).endsWith(`/pr-worktree-governance-tests-${process.pid}/body.md`)
        ? mocks.body()
        : actual.safeReadFile(file, options),
    safeExistsSync: (file: string) =>
      file.endsWith('/libs/core/dist/vcs/publication-host.js') || actual.safeExistsSync(file),
  };
});

import {
  publicationBodySourceTier,
  publishWithWorktreeGovernance,
  resolvePrGovernanceRoot,
} from './pr-worktree-governance.js';

const current = pathResolver.rootDir();
const fixtureDir = pathResolver.sharedTmp(`pr-worktree-governance-tests-${process.pid}`);
const bodyFile = path.join(fixtureDir, 'body.md');
beforeAll(() => safeWriteFile(bodyFile, 'protected PR text'));
afterAll(() => safeRmSync(fixtureDir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());
const installation = path.join(current, 'installation-fixture');
const common = path.join(installation, '.git');
const run: GitRunner = (args, cwd) => {
  if (args.includes('--git-common-dir')) return { status: 0, stdout: common, stderr: '' };
  if (args.includes('--show-toplevel')) return { status: 0, stdout: cwd, stderr: '' };
  if (args.includes('--show-prefix')) return { status: 0, stdout: '', stderr: '' };
  throw new Error(`unexpected git arguments ${args.join(' ')}`);
};

describe('PR governance root continuity', () => {
  it('uses the primary checkout for a secondary worktree of the same repository', () => {
    expect(resolvePrGovernanceRoot(current, run)).toBe(installation);
    expect(resolvePrGovernanceRoot(installation, run)).toBe(installation);
  });

  it('refuses an installation whose Git common directory differs', () => {
    const mismatch: GitRunner = (args, cwd) =>
      args.includes('--git-common-dir') && cwd === installation
        ? { status: 0, stdout: '/foreign/.git', stderr: '' }
        : run(args, cwd);
    expect(() => resolvePrGovernanceRoot(current, mismatch)).toThrow(/different repository/);
  });

  it('retains local behavior for bare/separate-git-dir layouts and fails closed on missing Git', () => {
    expect(
      resolvePrGovernanceRoot(current, () => ({
        status: 0,
        stdout: '/bare/repository.git',
        stderr: '',
      }))
    ).toBe(current);
    expect(() =>
      resolvePrGovernanceRoot(current, () => ({ status: 128, stdout: '', stderr: '' }))
    ).toThrow(/Cannot identify repository/);
  });

  it('preserves protected body provenance when freezing a worktree file', () => {
    expect(publicationBodySourceTier(bodyFile)).toBe('protected_or_unknown');
    expect(
      publicationBodySourceTier('knowledge/public/procedures/system/github-pr-management.md')
    ).toBe('public');
    expect(publicationBodySourceTier(undefined)).toBe('inline');
    expect(() => publicationBodySourceTier('../outside.md')).toThrow();
  });

  it('never discovers a live installation implicitly in a Vitest process', () => {
    const publication = { title: 'fix(ci): fixture', head: 'work', base: 'main' };
    const receipt = { status: 0, stdout: 'fixture', stderr: '' };
    mocks.local.mockReturnValue(receipt);
    expect(publishWithWorktreeGovernance(publication, 'invocation', () => undefined)).toBe(receipt);
    expect(mocks.local).toHaveBeenCalledWith(
      { operation: 'pr_create', params: publication },
      'invocation',
      expect.any(Function)
    );
  });

  it.each(['KYBERION_SUDO', 'KYBERION_SUDO_SCOPE'])(
    'keeps temporary %s authority in its original checkout',
    (key) => {
      vi.stubEnv(key, key === 'KYBERION_SUDO' ? 'true' : 'all');
      const receipt = { status: 0, stdout: 'fixture', stderr: '' };
      mocks.local.mockReturnValue(receipt);
      const transport = vi.fn();
      expect(
        publishWithWorktreeGovernance(
          { title: 'fix(vcs): elevated scope' },
          'stable',
          () => undefined,
          { governanceRoot: installation, gitRunner: run, transport }
        )
      ).toBe(receipt);
      expect(transport).not.toHaveBeenCalled();
    }
  );

  it('rejects prototype-bearing data from the canonical child', () => {
    expect(() =>
      publishWithWorktreeGovernance({ title: 'fix(vcs): fixture' }, 'stable', () => undefined, {
        governanceRoot: installation,
        gitRunner: run,
        transport: () => ({
          status: 0,
          stderr: '',
          stdout:
            'KYBERION_PR_GOVERNANCE_RESULT:{"ok":true,"result":{"status":0,"__proto__":{"polluted":true}}}\n',
        }),
      })
    ).toThrow(/dangerous JSON key/);
  });

  it('transports frozen content as data, keeps credentials out of stdin, and surfaces the canonical human command', () => {
    const print = vi.fn();
    const transport = vi.fn(({ payload, env, root }) => {
      const input = JSON.parse(payload);
      expect(root).toBe(installation);
      expect(input.mutation.operation).toBe('pr_create');
      expect(input.mutation.params).toEqual({
        cwd: current,
        title: 'fix(pr): title',
        head: 'work',
        base: 'main',
        body: 'protected PR text',
      });
      expect(input.mutation.params).not.toHaveProperty('bodyFile');
      expect(input.bodySourceTier).toBe('protected_or_unknown');
      expect(input.invocationId).toBe('stable');
      expect(input.coreUrl).toMatch(/\/libs\/core\/dist\/$/);
      expect(payload).not.toContain('fixture-secret');
      expect(env.GH_TOKEN).toBe('fixture-secret');
      return {
        status: 0,
        stderr: '',
        stdout:
          'harmless startup log\nKYBERION_PR_GOVERNANCE_RESULT:' +
          JSON.stringify({
            ok: false,
            error: '[EXTERNAL_APPROVAL_REQUIRED] apr-1',
            lines: [`Approve at ${installation}: apr-1`],
          }) +
          '\n',
      };
    });
    expect(() =>
      publishWithWorktreeGovernance(
        {
          title: 'fix(pr): title',
          head: 'work',
          base: 'main',
          bodyFile,
          env: { GH_TOKEN: 'fixture-secret' },
        },
        'stable',
        print,
        { governanceRoot: installation, gitRunner: run, transport }
      )
    ).toThrow(/EXTERNAL_APPROVAL_REQUIRED/);
    expect(print).toHaveBeenCalledWith(`Approve at ${installation}: apr-1`);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('returns the child receipt and refuses a missing/failed child response without a retry', () => {
    const receipt = { status: 0, stdout: 'https://github.com/fixture/repo/pull/1', stderr: '' };
    const transport = vi.fn(() => ({
      status: 0,
      stderr: '',
      stdout:
        'KYBERION_PR_GOVERNANCE_RESULT:' + JSON.stringify({ ok: true, result: receipt }) + '\n',
    }));
    expect(
      publishWithWorktreeGovernance({ title: 'fix(pr): fixture' }, 'stable', () => undefined, {
        governanceRoot: installation,
        gitRunner: run,
        transport,
      })
    ).toEqual(receipt);
    const unavailable = vi.fn(() => ({ status: 1, stdout: '', stderr: 'unavailable' }));
    expect(() =>
      publishWithWorktreeGovernance({ title: 'fix(pr): fixture' }, 'stable', () => undefined, {
        governanceRoot: installation,
        gitRunner: run,
        transport: unavailable,
      })
    ).toThrow(/Verify prior publication/);
    expect(unavailable).toHaveBeenCalledTimes(1);
  });
});

import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectDiscussionReadiness } from './discussion-readiness.js';
const probe = vi.hoisted(() => ({
  resolve: vi.fn(),
  egress: vi.fn(),
  scope: vi.fn(),
  binary: vi.fn(),
  guard: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(),
  generate: vi.fn(),
}));
vi.mock('../provider/isolated-text-generator.js', () => ({
  resolveIsolatedTextGenerator: probe.resolve,
}));
vi.mock('../provider/codex-cli-query.js', () => ({ resolveCodexBinary: probe.binary }));
vi.mock('../reasoning/reasoning-egress-scope.js', () => ({
  assertReasoningEgressAllowed: probe.egress,
  withReasoningPayloadScope: probe.scope,
}));
vi.mock('../workforce/artifact-store.js', () => ({ resolveGovernedArtifactPath: probe.guard }));
vi.mock('../secure-io.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../secure-io.js')>()),
  safeStat: probe.stat,
  safeLstat: probe.lstat,
}));
vi.mock('../path-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../path-resolver.js')>();
  return {
    ...actual,
    pathResolver: { ...actual.pathResolver, rootDir: () => path.resolve('/fixture') },
  };
});
const directory = () => ({ isDirectory: () => true, isSymbolicLink: () => false });
const missing = () => Object.assign(new Error('private path details'), { code: 'ENOENT' });
const check = (id: string, provider: 'claude' | 'codex' = 'codex') =>
  inspectDiscussionReadiness(provider, {
    tenant_slug: 'fixture',
    tier: 'confidential',
  }).checks.find((c) => c.id === id);
beforeEach(() => {
  vi.resetAllMocks();
  probe.resolve.mockReturnValue({ reasoningBackend: 'codex-cli', generate: probe.generate });
  probe.scope.mockImplementation((_scope, fn) => fn());
  probe.binary.mockReturnValue('/private/codex');
  probe.guard.mockImplementation((p: string) => path.resolve('/fixture', p));
  probe.stat.mockReturnValue({ isFile: () => true });
  probe.lstat.mockReturnValue(directory());
});
describe('Discussion static readiness', () => {
  it('checks only configuration and metadata, with live execution explicitly unknown', () => {
    const result = inspectDiscussionReadiness('codex', { tenant_slug: 'fixture' });
    expect(result).toMatchObject({ provider: 'codex', execution: 'unverified', provider_calls: 0 });
    expect(result.checks).toContainEqual({
      id: 'live_execution',
      status: 'unverified',
      code: 'live_execution_unverified',
    });
    expect(result.checks.some((c) => c.status === 'blocked')).toBe(false);
    expect(probe.scope).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 'confidential',
        tenant_slug: 'fixture',
        training_use: 'no_training',
        purpose: 'discussion:decision',
      }),
      expect.any(Function)
    );
    expect(probe.egress).toHaveBeenCalledWith('codex-cli');
    expect(probe.generate).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('/private');
  });
  it('does not claim or create a room, artifact, scratch workspace or provider session', () => {
    inspectDiscussionReadiness('codex', { tenant_slug: 'fixture' });
    expect(probe.guard.mock.calls.map((c) => c[0])).toEqual([
      'active/shared/runtime/discussions',
      'active/shared/runtime/artifacts',
    ]);
    expect(probe.generate).not.toHaveBeenCalled();
  });
  it('reports a missing confidential tenant before checking provider policy', () => {
    const result = inspectDiscussionReadiness('codex', {});
    expect(result.checks).toContainEqual({
      id: 'scope',
      status: 'blocked',
      code: 'tenant_required',
    });
    expect(probe.egress).not.toHaveBeenCalled();
  });
  it('reports an unavailable adapter without calling the provider', () => {
    probe.resolve.mockImplementation(() => {
      throw new Error('secret adapter detail');
    });
    expect(check('adapter')).toEqual({
      id: 'adapter',
      status: 'blocked',
      code: 'adapter_unavailable',
    });
    expect(probe.egress).not.toHaveBeenCalled();
    expect(probe.generate).not.toHaveBeenCalled();
  });
  it('masks egress denial details without relaxing the configured gate', () => {
    probe.egress.mockImplementation(() => {
      throw new Error('secret endpoint and tenant');
    });
    expect(check('egress_policy')).toEqual({
      id: 'egress_policy',
      status: 'blocked',
      code: 'egress_denied',
    });
    expect(
      JSON.stringify(inspectDiscussionReadiness('codex', { tenant_slug: 'fixture' }))
    ).not.toContain('secret');
  });
  it('does not confuse a configured path with an existing file', () => {
    probe.stat.mockImplementation(() => {
      throw missing();
    });
    expect(check('executable')).toEqual({
      id: 'executable',
      status: 'blocked',
      code: 'executable_missing',
    });
  });
  it('rejects a directory candidate without claiming executable capability', () => {
    probe.stat.mockReturnValue({ isFile: () => false });
    expect(check('executable')?.code).toBe('executable_missing');
  });
  it('keeps denied metadata inspection unknown rather than claiming absence', () => {
    probe.stat.mockImplementation(() => {
      throw new Error('read policy denies private path');
    });
    expect(check('executable')).toEqual({
      id: 'executable',
      status: 'unverified',
      code: 'executable_inspection_unavailable',
    });
  });
  it('keeps locator failure unknown rather than inventing an installation result', () => {
    probe.binary.mockImplementation(() => {
      throw new Error('locator denied');
    });
    expect(check('executable')?.status).toBe('unverified');
  });
  it('does not inspect PATH claude because the SDK selects its native executable', () => {
    expect(check('executable', 'claude')).toEqual({
      id: 'executable',
      status: 'unverified',
      code: 'executable_unverified',
    });
    expect(probe.binary).not.toHaveBeenCalled();
    expect(probe.stat).not.toHaveBeenCalled();
  });
  it('distinguishes existing artifact directories from missing children', () => {
    expect(check('artifact_destination')?.code).toBe('artifact_directory_inspected');
    probe.lstat.mockImplementation((p: string) => {
      if (/discussions$|artifacts$/.test(p)) throw missing();
      return directory();
    });
    expect(check('artifact_destination')).toEqual({
      id: 'artifact_destination',
      status: 'checked',
      code: 'artifact_parent_inspected',
    });
  });
  it.each(['symlink', 'file', 'guard', 'denied'])(
    'fails closed for %s artifact destinations without creating anything',
    (kind) => {
      if (kind === 'guard')
        probe.guard.mockImplementation(() => {
          throw new Error('unsafe path');
        });
      else if (kind === 'denied')
        probe.lstat.mockImplementation(() => {
          throw new Error('permission denied');
        });
      else
        probe.lstat.mockReturnValue({
          isDirectory: () => kind === 'symlink',
          isSymbolicLink: () => kind === 'symlink',
        });
      expect(check('artifact_destination')).toEqual({
        id: 'artifact_destination',
        status: 'blocked',
        code: 'artifact_unavailable',
      });
    }
  );
  it('bounds missing-parent traversal at the repository root', () => {
    probe.lstat.mockImplementation(() => {
      throw missing();
    });
    expect(check('artifact_destination')?.status).toBe('blocked');
    expect(probe.lstat.mock.calls.every(([p]) => p.startsWith(path.resolve('/fixture')))).toBe(
      true
    );
    expect(probe.lstat.mock.calls.length).toBeLessThan(10);
  });
});

it.each(['codex', './codex', '../bin/codex'])(
  'does not stat non-absolute override %s against the wrong cwd',
  (binary) => {
    probe.binary.mockReturnValue(binary);
    expect(check('executable')).toEqual({
      id: 'executable',
      status: 'unverified',
      code: 'executable_inspection_unavailable',
    });
    expect(probe.stat).not.toHaveBeenCalled();
    expect(probe.generate).not.toHaveBeenCalled();
  }
);

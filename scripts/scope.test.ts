import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assetReadCeilingFor,
  inspectAssetScopeRead,
} from '@agent/core/governance/asset-scope-inspection';
import type { AssetScopeReadInspection } from '@agent/core/governance/asset-scope-inspection';
import {
  clearScopeEnv,
  popScopeEnv,
  pushScopeEnv,
  resolveScopeResolution,
  writeScopeEnv,
} from '@agent/core/scope-context';
import { clearProcessExitCode, getProcessExitCode } from './lib/harness.js';
import { main } from './scope.js';

vi.mock('@agent/core/governance/asset-scope-inspection', () => ({
  assetReadCeilingFor: vi.fn(),
  inspectAssetScopeRead: vi.fn(),
}));
vi.mock('@agent/core/scope-context', () => ({
  clearScopeEnv: vi.fn(),
  popScopeEnv: vi.fn(),
  pushScopeEnv: vi.fn(),
  resolveScopeResolution: vi.fn(),
  writeScopeEnv: vi.fn(),
}));

const address = {
  path: 'active/shared/runtime/example/confidential/acme/row.json',
  store: 'example',
  location: 'active' as const,
  custody: { kind: 'tenant' as const, ref: 'acme' },
  tier: 'confidential' as const,
};
const resolved: AssetScopeReadInspection = {
  decision: { allowed: true },
  shadow: { status: 'address_only', resolution: { status: 'resolved', address } },
};
const stdout: string[] = [];
const stderr: string[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  stdout.length = 0;
  stderr.length = 0;
  vi.spyOn(console, 'log').mockImplementation((value) => stdout.push(String(value)));
  vi.spyOn(console, 'error').mockImplementation((value) => stderr.push(String(value)));
  vi.mocked(inspectAssetScopeRead).mockReturnValue(resolved);
  clearProcessExitCode();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearProcessExitCode();
});

function expectNoScopeAccess(): void {
  for (const method of [
    clearScopeEnv,
    popScopeEnv,
    pushScopeEnv,
    resolveScopeResolution,
    writeScopeEnv,
  ])
    expect(method).not.toHaveBeenCalled();
}

describe('scope inspect', () => {
  it('prints one JSON policy/address report without a trusted ceiling or persisted scope', async () => {
    await main(['inspect', address.path, '--json']);
    expect(inspectAssetScopeRead).toHaveBeenCalledExactlyOnceWith(address.path);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual({
      ...resolved,
      limits: {
        decision: 'read_policy_only',
        existence: 'undetermined',
        full_io_admission: 'not_evaluated',
        target_content: 'not_returned',
        ceiling_comparison: 'not_requested',
      },
    });
    expect(stderr).toEqual([]);
    expect(getProcessExitCode() ?? 0).toBe(0);
    expectNoScopeAccess();
  });

  it('labels human output as read policy and separates attribution from full IO admission', async () => {
    await main(['inspect', address.path]);
    expect(stdout).toEqual([
      'read policy=allowed',
      'reason=(unspecified)',
      'store=example',
      'location=active',
      'custody=tenant:acme',
      'tier=confidential',
      'trusted ceiling comparison=not requested',
      'existence=undetermined; full IO admission=not evaluated; no target content output',
    ]);
    expectNoScopeAccess();
  });

  it('compares against the ceiling of the process identity only when asked', async () => {
    const ceiling = {
      custodians: [{ kind: 'tenant' as const, ref: 'acme' }],
      readTiers: ['confidential' as const],
    };
    vi.mocked(assetReadCeilingFor).mockReturnValue(ceiling);
    vi.mocked(inspectAssetScopeRead).mockReturnValue({
      decision: { allowed: true },
      shadow: {
        status: 'compared',
        resolution: { status: 'resolved', address },
        observation: { allowed: true, reason: 'within_ceiling' },
        agrees: true,
      },
    });
    await main(['inspect', address.path, '--compare-identity']);
    expect(assetReadCeilingFor).toHaveBeenCalledExactlyOnceWith();
    expect(inspectAssetScopeRead).toHaveBeenCalledExactlyOnceWith(address.path, ceiling);
    expect(stdout).toContain('identity ceiling=within (within_ceiling); agrees=true');
    expectNoScopeAccess();
  });

  it('reports an unbound identity as having no ceiling to compare', async () => {
    vi.mocked(assetReadCeilingFor).mockReturnValue(undefined);
    await main(['inspect', address.path, '--compare-identity', '--json']);
    expect(inspectAssetScopeRead).toHaveBeenCalledExactlyOnceWith(address.path);
    expect(JSON.parse(stdout[0]).limits.ceiling_comparison).toBe('identity_unbound');
  });

  it.each(['planned', 'legacy-move'] as const)(
    'reports %s attribution without replacing the denied policy decision',
    async (location) => {
      vi.mocked(inspectAssetScopeRead).mockReturnValue({
        decision: { allowed: false, reason: 'role denial' },
        shadow: {
          status: 'address_only',
          resolution: { status: 'resolved', address: { ...address, location } },
        },
      });
      await main(['inspect', address.path]);
      expect(stdout).toContain('read policy=denied');
      expect(stdout).toContain(`location=${location}`);
      expect(stdout).toContain('custody=tenant:acme');
      expect(inspectAssetScopeRead).toHaveBeenCalledExactlyOnceWith(address.path);
      expect(getProcessExitCode() ?? 0).toBe(0);
      expectNoScopeAccess();
    }
  );

  it.each<AssetScopeReadInspection['shadow']>([
    { status: 'unavailable' },
    {
      status: 'unresolved',
      resolution: { status: 'unresolved', reason: 'unknown_store', stores: [] },
    },
  ])('preserves denied policy and $status shadow as a successful diagnosis', async (shadow) => {
    const denied = { decision: { allowed: false, reason: 'ROLE_TENANT_SCOPE_MISMATCH' }, shadow };
    vi.mocked(inspectAssetScopeRead).mockReturnValue(denied);
    await main(['--json', 'inspect', 'knowledge/confidential/other/data.json']);
    expect(JSON.parse(stdout[0])).toMatchObject(denied);
    expect(getProcessExitCode() ?? 0).toBe(0);
    expect(stderr).toEqual([]);
    expectNoScopeAccess();
  });

  it.each([
    [{ status: 'unavailable' }, 'asset=unavailable'],
    [
      {
        status: 'unresolved',
        resolution: { status: 'unresolved', reason: 'custody_unresolved', stores: ['example'] },
      },
      'asset=unresolved (custody_unresolved)',
    ],
  ] as const)('renders human attribution state %j', async (shadow, line) => {
    vi.mocked(inspectAssetScopeRead).mockReturnValue({
      decision: { allowed: false, reason: 'policy denial' },
      shadow,
    });
    await main(['inspect', 'missing.json']);
    expect(stdout).toContain('read policy=denied');
    expect(stdout).toContain('reason=policy denial');
    expect(stdout).toContain(line);
    expect(getProcessExitCode() ?? 0).toBe(0);
    expectNoScopeAccess();
  });

  it.each([
    ['inspect'],
    ['inspect', ''],
    ['inspect', '   '],
    ['inspect', 'one', 'two'],
    ['inspect', 'one', '--tenant', 'acme'],
    ['inspect', '--tier', 'personal'],
    ['inspect', 'one', '--unknown'],
    ['inspect', 'one', '--dry-run'],
    ['inspect', 'one', '--json=true'],
    ['inspect', 'one', '--json', '--json'],
    ['inspect', '--', 'one'],
  ])('rejects invalid argv %j before policy inspection', async (...argv) => {
    await main([...argv, '--json']);
    expect(getProcessExitCode()).toBe(2);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr[0])).toMatchObject({
      ok: false,
      error: 'Usage: pnpm scope inspect <path> [--compare-identity] [--json]',
    });
    expect(inspectAssetScopeRead).not.toHaveBeenCalled();
    expectNoScopeAccess();
  });
});

it('preserves the existing operator scope command', async () => {
  await main(['operator']);
  expect(writeScopeEnv).toHaveBeenCalledExactlyOnceWith({ tier: 'personal' });
  expect(inspectAssetScopeRead).not.toHaveBeenCalled();
  expect(getProcessExitCode() ?? 0).toBe(0);
});

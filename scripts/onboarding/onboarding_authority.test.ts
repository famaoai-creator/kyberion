import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  exists: false,
  writes: [] as unknown[][],
  installation: false,
  concurrentPreview: '',
}));
vi.mock('@agent/core/foundation/json', () => ({
  writeJson: (file: string, value: unknown, options?: { createOnly?: boolean }) => {
    if (options?.createOnly && state.concurrentPreview) throw new Error('EEXIST');
    state.writes.push([file, JSON.stringify(value, null, 2) + '\n', options]);
  },
}));
vi.mock('@agent/core/authority', () => ({
  // S4: store facades open their declared store grant (withStoreGrant).
  withStoreGrant: (_name: string, fn: () => unknown) => fn(),
  withStoreGrantAsync: async (_name: string, fn: () => unknown) => fn(),
  withExecutionContext: (_role: string, run: () => unknown) => run(),
}));
vi.mock('@agent/core/profile-root', () => ({
  resolveActiveProfileRoot: () => '/repo/knowledge/personal',
}));
vi.mock('@agent/core/personal-identity-state', () => ({
  loadPersonalIdentityAtPath: () => ({ name: 'operator' }),
}));
vi.mock('@agent/core/organization/member-registry', () => ({ ensureOwnerMember: () => undefined }));
vi.mock('@agent/core/governance/cli-operator-principal', () => ({
  resolveCliOperatorIdentity: () => ({ principalId: 'owner' }),
  resolveCliApprovalRequester: () => ({ actorId: 'agent' }),
}));
vi.mock('@agent/core/secure-io', () => ({
  assertSafeRepositoryPath: (value: string) => value,
  safeExistsSync: () => state.exists,
  safeWriteFile: (...args: unknown[]) => state.writes.push(args),
}));
vi.mock('../lib/json-input.js', () => ({
  readSafeJsonFile: () => ({ input: { action: 'activation' } }),
}));
vi.mock('../lib/installed-identity.js', () => ({
  inspectInstalledIdentity: () => ({
    ready: true,
    governance_root: '/canonical',
    source: state.installation ? 'installation' : 'local',
  }),
  canonicalAuthorityCommand: () => 'canonical-command',
}));
vi.mock('@agent/core/organization/onboarding-authority', () => ({
  onboardingAuthorityScope: (value: Record<string, unknown>) => ({
    kind: value.scope_kind,
    ...(value.tenant_slug ? { tenant_slug: value.tenant_slug } : {}),
  }),
  previewOnboardingAuthority: vi.fn(() => ({
    digest: 'digest',
    base_hash: 'base',
    statement: 'review',
  })),
  readOnboardingAuthority: () => ({}),
  requestOnboardingAuthority: vi.fn(),
  onboardingAuthorityRequestStatus: vi.fn(),
  applyOnboardingAuthority: vi.fn(),
}));
import { main } from './onboarding_authority.js';
import { previewOnboardingAuthority } from '@agent/core/organization/onboarding-authority';
describe('onboarding authority reviewed preview output', () => {
  beforeEach(() => {
    state.exists = false;
    state.installation = false;
    state.writes = [];
    state.concurrentPreview = '';
  });
  it('saves the exact reviewed envelope exclusively under the active profile', async () => {
    const print = vi.fn();
    await main(
      [
        'preview',
        '--file',
        '/repo/input.json',
        '--out',
        '/repo/knowledge/personal/onboarding/reviewed.json',
      ],
      print
    );
    expect(state.writes).toHaveLength(1);
    expect(JSON.parse(state.writes[0][1] as string)).toEqual({
      input: { action: 'activation' },
      digest: 'digest',
      base_hash: 'base',
      statement: 'review',
    });
    expect(state.writes[0][2]).toEqual({ createOnly: true });
    expect(print).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewed_file: '/repo/knowledge/personal/onboarding/reviewed.json',
      })
    );
  });
  it('preserves a reviewed preview created after the existence precheck', async () => {
    state.concurrentPreview = '{"digest":"already-reviewed"}\n';
    await expect(
      main([
        'preview',
        '--file',
        '/repo/input.json',
        '--out',
        '/repo/knowledge/personal/reviewed.json',
      ])
    ).rejects.toThrow('EEXIST');
    expect(state.concurrentPreview).toBe('{"digest":"already-reviewed"}\n');
    expect(state.writes).toEqual([]);
  });
  it('refuses existing output, public output and output on a non-preview command', async () => {
    state.exists = true;
    await expect(
      main([
        'preview',
        '--file',
        '/repo/input.json',
        '--out',
        '/repo/knowledge/personal/reviewed.json',
      ])
    ).rejects.toThrow('already exists');
    state.exists = false;
    await expect(
      main([
        'preview',
        '--file',
        '/repo/input.json',
        '--out',
        '/repo/knowledge/public/reviewed.json',
      ])
    ).rejects.toThrow('active personal profile');
    await expect(main(['show', '--out', '/repo/knowledge/personal/reviewed.json'])).rejects.toThrow(
      'only valid for preview'
    );
    expect(state.writes).toEqual([]);
  });
  it('directs worktrees to the canonical authority without copying or writing state', async () => {
    state.installation = true;
    await expect(main(['show'])).rejects.toThrow('canonical-command');
    expect(state.writes).toEqual([]);
  });
});

describe('onboarding authority flag-composed grants', () => {
  beforeEach(() => {
    state.exists = false;
    state.installation = false;
    state.writes = [];
    state.concurrentPreview = '';
    vi.mocked(previewOnboardingAuthority).mockClear();
  });
  it('composes exact-target grants from --grant/--grant-field without --file', async () => {
    await main([
      'preview',
      '--scope',
      'person',
      '--grant',
      'vcs:pr_create',
      '--grant-field',
      'repository=https://github.com/acme/widgets',
      '--expires-at',
      '2030-01-01',
    ]);
    expect(previewOnboardingAuthority).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope_kind: 'person',
        mode: 'grant',
        expires_at: '2030-01-01',
        grants: [
          {
            operation_id: 'vcs:pr_create',
            repository: 'https://github.com/acme/widgets',
          },
        ],
      })
    );
  });
  it('attaches each --grant-field to the most recent --grant', async () => {
    await main([
      'preview',
      '--scope',
      'person',
      '--grant',
      'vcs:pr_create',
      '--grant-field',
      'repository=https://github.com/acme/widgets',
      '--grant',
      'service:slack:preset:post_message',
      '--grant-field',
      'channel=#alerts',
      '--expires-at',
      '2030-01-01',
    ]);
    expect(vi.mocked(previewOnboardingAuthority).mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        grants: [
          { operation_id: 'vcs:pr_create', repository: 'https://github.com/acme/widgets' },
          { operation_id: 'service:slack:preset:post_message', channel: '#alerts' },
        ],
      })
    );
  });
  it('refuses unknown operations, undeclared fields and malformed flag input', async () => {
    const base = ['preview', '--scope', 'person', '--expires-at', '2030-01-01'] as const;
    await expect(main([...base, '--grant', 'mcp:call_tool'])).rejects.toThrow(
      'invalid delegation grant'
    );
    await expect(
      main([...base, '--grant', 'vcs:pr_create', '--grant-field', 'bogus=x'])
    ).rejects.toThrow('invalid delegation grant');
    await expect(
      main([...base, '--grant-field', 'repository=x', '--grant', 'vcs:pr_create'])
    ).rejects.toThrow('must follow a --grant');
    expect(previewOnboardingAuthority).not.toHaveBeenCalled();
  });
  it('requires --expires-at and rejects --file/--grant mixing or non-preview actions', async () => {
    await expect(
      main(['preview', '--scope', 'person', '--grant', 'vcs:pr_create'])
    ).rejects.toThrow('--expires-at is required');
    await expect(
      main([
        'preview',
        '--file',
        '/repo/input.json',
        '--grant',
        'vcs:pr_create',
        '--expires-at',
        '2030-01-01',
      ])
    ).rejects.toThrow('mutually exclusive');
    await expect(
      main(['request', '--grant', 'vcs:pr_create', '--expires-at', '2030-01-01'])
    ).rejects.toThrow('only valid for preview');
    expect(previewOnboardingAuthority).not.toHaveBeenCalled();
  });
});

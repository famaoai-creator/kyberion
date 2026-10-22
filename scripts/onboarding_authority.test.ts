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
vi.mock('./lib/json-input.js', () => ({
  readSafeJsonFile: () => ({ input: { action: 'activation' } }),
}));
vi.mock('./lib/installed-identity.js', () => ({
  inspectInstalledIdentity: () => ({
    ready: true,
    governance_root: '/canonical',
    source: state.installation ? 'installation' : 'local',
  }),
  canonicalAuthorityCommand: () => 'canonical-command',
}));
vi.mock('@agent/core/organization/onboarding-authority', () => ({
  onboardingAuthorityScope: (value: unknown) => value,
  previewOnboardingAuthority: () => ({ digest: 'digest', base_hash: 'base', statement: 'review' }),
  readOnboardingAuthority: () => ({}),
  requestOnboardingAuthority: vi.fn(),
  onboardingAuthorityRequestStatus: vi.fn(),
  applyOnboardingAuthority: vi.fn(),
}));
import { main } from './onboarding_authority.js';
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

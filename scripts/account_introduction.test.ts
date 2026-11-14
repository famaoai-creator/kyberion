import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  installed: vi.fn(),
  owner: vi.fn(),
  requester: vi.fn(),
  preview: vi.fn(),
  propose: vi.fn(),
  status: vi.fn(),
  apply: vi.fn(),
  collect: vi.fn(),
  review: vi.fn(),
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContextAsync: (_role: string, run: () => unknown) => run(),
}));
vi.mock('@agent/core/secure-io', () => ({
  assertSafeRepositoryPath: (file: string) => file,
  withSensitivePathMediation: (run: () => unknown) => run(),
}));
vi.mock('@agent/core/profile-root', () => ({
  resolveActiveProfileRoot: () => '/repo/knowledge/personal',
}));
vi.mock('@agent/core/governance/cli-operator-principal', () => ({
  resolveCliOperatorIdentity: m.owner,
  resolveCliApprovalRequester: m.requester,
}));
vi.mock('@agent/core/governance/approval-store', () => ({
  computeApprovalPayloadHash: (value: unknown) => JSON.stringify(value),
}));
vi.mock('@agent/core/secret/account-introduction', () => ({
  previewAccountIntroduction: m.preview,
  proposeAccountIntroduction: m.propose,
  accountIntroductionStatus: m.status,
  applyAccountIntroduction: m.apply,
}));
vi.mock('@agent/core/foundation/secret-resolution-session', () => ({
  withSecretResolutionSession: (run: () => unknown) => run(),
}));
vi.mock('./lib/installed-identity.js', () => ({ inspectInstalledIdentity: m.installed }));
vi.mock('./lib/json-input.js', () => ({ readSafeJsonFile: m.review }));
vi.mock('./lib/hidden-token-input.js', () => ({ readHiddenToken: m.collect }));
import { main, runAccountIntroductionCli } from './account_introduction.js';
const preview = {
  binding_id: 'github-owner',
  digest: 'reviewed',
  expected_generation: null,
  secret_refs: ['GITHUB_TOKEN'],
  statement: 'Account review',
};
const principal = {
  requesterId: 'user:owner',
  accountableId: 'user:owner',
  personalOwner: true,
  tenantSlugs: 'all',
};
beforeEach(() => {
  vi.resetAllMocks();
  m.installed.mockReturnValue({ ready: true, source: 'local' });
  m.owner.mockReturnValue({ principalId: 'user:owner' });
  m.requester.mockReturnValue({ actorId: 'user:owner' });
  m.preview.mockReturnValue(preview);
  m.review.mockReturnValue(preview);
  m.propose.mockReturnValue({
    approval_id: 'approval',
    status: 'pending',
    approval_url: '/?approvalId=approval',
  });
  m.status.mockReturnValue({ can_apply: true });
  m.collect.mockResolvedValue('synthetic-secret');
  m.apply.mockResolvedValue({ status: 'applied', generation: 'generation' });
});
describe('account registration CLI adapter', () => {
  it('emits review metadata without collecting or storing any token', async () => {
    const print = vi.fn();
    await main(['preview', 'github-owner', '--json'], print);
    expect(print).toHaveBeenCalledWith(preview);
    expect(m.preview).toHaveBeenCalledWith(principal, 'github-owner');
    expect(m.collect).not.toHaveBeenCalled();
    expect(m.apply).not.toHaveBeenCalled();
  });
  it('requires the exact reviewed metadata and forwards only its digest and generation', async () => {
    const result = await runAccountIntroductionCli([
      'request',
      'github-owner',
      '--review',
      '/repo/knowledge/personal/review.json',
    ]);
    expect(result).toMatchObject({ status: 'pending', approval_url: expect.any(String) });
    expect(m.propose).toHaveBeenCalledWith(principal, 'github-owner', {
      digest: 'reviewed',
      expected_generation: null,
    });
    expect(m.collect).not.toHaveBeenCalled();
  });
  it.each([
    { ...preview, binding_id: 'other' },
    { ...preview, digest: 'old' },
    { ...preview, expected_generation: 'old-generation' },
    { ...preview, statement: 'different' },
    { ...preview, material: { GITHUB_TOKEN: 'forbidden' } },
  ])('refuses altered metadata before requesting approval', async (review) => {
    m.review.mockReturnValue(review);
    await expect(
      runAccountIntroductionCli([
        'request',
        'github-owner',
        '--review',
        '/repo/knowledge/personal/review.json',
      ])
    ).rejects.toThrow('Review changed');
    expect(m.propose).not.toHaveBeenCalled();
    expect(m.collect).not.toHaveBeenCalled();
  });
  it.each([
    '--value',
    '--secret',
    '--from-file',
    '--service',
    '--owner',
    '--tenant',
    '--out',
    '--auto-approve',
  ])('rejects %s without echoing its value', async (flag) => {
    await expect(
      runAccountIntroductionCli(['apply', 'github-owner', flag, 'synthetic-secret'])
    ).rejects.toThrow('Unsupported option');
    expect(m.installed).not.toHaveBeenCalled();
    expect(m.collect).not.toHaveBeenCalled();
  });
  it('rejects extra and duplicate flags', async () => {
    await expect(
      runAccountIntroductionCli(['preview', 'github-owner', '--json', '--json'])
    ).rejects.toThrow('Duplicate');
    await expect(
      runAccountIntroductionCli(['preview', 'github-owner', 'synthetic-secret'])
    ).rejects.toThrow('Unsupported');
  });
  it.each([
    { ready: false, source: 'local' },
    { ready: true, source: 'installation' },
  ])('refuses another or incomplete installation', async (installed) => {
    m.installed.mockReturnValue(installed);
    await expect(runAccountIntroductionCli(['preview', 'github-owner'])).rejects.toThrow(
      'installed owner checkout'
    );
    expect(m.preview).not.toHaveBeenCalled();
  });
  it('does not provision a missing operator identity', async () => {
    m.owner.mockReturnValue({ principalId: null });
    await expect(runAccountIntroductionCli(['preview', 'github-owner'])).rejects.toThrow(
      'Existing registered'
    );
    expect(m.preview).not.toHaveBeenCalled();
  });
  it('refuses review files outside the active personal profile', async () => {
    await expect(
      runAccountIntroductionCli(['request', 'github-owner', '--review', '/repo/public/review.json'])
    ).rejects.toThrow('active personal profile');
    expect(m.review).not.toHaveBeenCalled();
  });
  it('does not collect values for unapproved or incomplete requests', async () => {
    m.status.mockReturnValue({ can_apply: false, status: 'recovery_required' });
    await expect(
      runAccountIntroductionCli(['apply', 'github-owner', '--approval-id', 'approval'])
    ).rejects.toThrow('cannot be applied');
    expect(m.collect).not.toHaveBeenCalled();
    expect(m.apply).not.toHaveBeenCalled();
  });
  it('revalidates after collection, clears references, and prints no token', async () => {
    let materialAtApply: unknown;
    m.apply.mockImplementation(async (_principal, _bindingId, input) => {
      materialAtApply = { ...input.material };
      return { status: 'applied', generation: 'generation' };
    });
    const print = vi.fn();
    await main(['apply', 'github-owner', '--approval-id', 'approval', '--json'], print);
    expect(materialAtApply).toEqual({ GITHUB_TOKEN: 'synthetic-secret' });
    expect(m.status).toHaveBeenCalledTimes(2);
    expect(m.apply.mock.calls[0][2].material).toEqual({});
    expect(JSON.stringify(print.mock.calls)).not.toContain('synthetic-secret');
  });
  it('does not apply when approval changes while the person types', async () => {
    m.status.mockReturnValueOnce({ can_apply: true }).mockReturnValueOnce({ can_apply: false });
    await expect(
      runAccountIntroductionCli(['apply', 'github-owner', '--approval-id', 'approval'])
    ).rejects.toThrow('changed during');
    expect(m.apply).not.toHaveBeenCalled();
  });
  it('does not apply or retry cancelled collection', async () => {
    m.collect.mockRejectedValue(new Error('Token entry cancelled'));
    await expect(
      runAccountIntroductionCli(['apply', 'github-owner', '--approval-id', 'approval'])
    ).rejects.toThrow('cancelled');
    expect(m.collect).toHaveBeenCalledTimes(1);
    expect(m.apply).not.toHaveBeenCalled();
  });
});

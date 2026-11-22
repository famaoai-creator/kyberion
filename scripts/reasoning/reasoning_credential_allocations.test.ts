import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContextAsync } from '@agent/core/authority';
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  list: vi.fn(),
  probe: vi.fn(),
  requestExtension: vi.fn(),
  extend: vi.fn(),
  registerTenant: vi.fn(),
  summarize: vi.fn(),
  introduce: vi.fn(),
  readRecord: vi.fn(),
  registerPerson: vi.fn(),
}));
vi.mock('@agent/core/governance/grant-store', () => ({
  registerCredentialLendingPolicy: () => undefined,
  requestGrantApproval: mocks.request,
  grantStanding: mocks.grant,
  revokeGrant: mocks.revoke,
  grantStatusAt: () => 'active',
  verifyGrantBasis: () => true,
  grantDaysLeft: () => 5,
  requestGrantExtension: mocks.requestExtension,
  extendStandingGrant: mocks.extend,
  GRANT_EXTENSION_GRACE_DAYS: 7,
}));
vi.mock('@agent/core/secret/credential-allocations', async (original) => ({
  ...(await original<typeof import('@agent/core/secret/credential-allocations')>()),
  CREDENTIAL_USE_CAPABILITY: 'credential.use',
  listCredentialAllocations: mocks.list,
  assertCredentialAllocation: vi.fn(),
  registerTenantCredential: mocks.registerTenant,
  readCredentialRecord: mocks.readRecord,
  registerPersonCredentialRecord: mocks.registerPerson,
  summarizeCredentialUsage: mocks.summarize,
  assessCredentialBudget: () => ({ status: 'warn', spent_usd: 85, budget_usd: 100, ratio: 0.85 }),
}));
vi.mock('./reasoning_credential_probe.js', () => ({ probeAllocatedCredential: mocks.probe }));
vi.mock('@agent/core/organization/tenant-registry', () => ({
  readTenantProfile: () => ({ tenant_slug: 'alpha', status: 'active' }),
}));
vi.mock('@agent/core/governance/cli-operator-principal', () => ({
  resolveCliApprovalRequester: () => ({ requestedBy: 'user:test' }),
  resolveCliOperatorIdentity: () => ({ principalId: 'user:owner', displayName: 'Owner' }),
}));
vi.mock('../secret/secret_introduce.js', () => ({
  collectSecret: async () => 'sk-ant-collected-0001',
  runSecretCli: mocks.introduce,
}));
vi.mock('../cli/cli-grants.js', () => ({
  resolveRevoker: () => ({ kind: 'human', id: 'user:test' }),
}));
import { runCredentialAllocationCommand } from './reasoning_credential_allocations.js';
const assign = [
  'assign',
  '--provider',
  'anthropic',
  '--tenant',
  'alpha',
  '--purpose',
  'Reasoning',
  '--days',
  '7',
];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockReturnValue([]);
});
describe('credential allocation commands', () => {
  it('requests an owner-approved extension of the same grant, then applies it', async () => {
    mocks.list.mockReturnValue([
      { grant_id: 'GRT-20261116-0000000000a1', expires_at: 'soon', scope: {} },
    ]);
    mocks.requestExtension.mockReturnValue({ id: 'approval-ext' });
    const print = vi.fn();
    const extend = ['extend', '--tenant', 'alpha', '--grant', 'GRT-20261116-0000000000a1'];
    expect(await runCredentialAllocationCommand([...extend, '--days', '30'], print)).toBe(0);
    expect(mocks.requestExtension).toHaveBeenCalledWith(
      { grant_id: 'GRT-20261116-0000000000a1', tenant_slug: 'alpha', extend_days: 30 },
      expect.any(Object)
    );
    expect(print.mock.calls.flat().join('')).toContain(
      'pnpm kyberion approvals --approve approval-ext'
    );
    expect(mocks.extend).not.toHaveBeenCalled();
    mocks.extend.mockReturnValue({
      grant_id: 'GRT-20261116-0000000000a1',
      expires_at: 'later',
    });
    const applied = vi.fn();
    await runCredentialAllocationCommand([...extend, '--approval', 'approval-ext'], applied);
    expect(mocks.extend).toHaveBeenCalledWith(
      { grant_id: 'GRT-20261116-0000000000a1', tenant_slug: 'alpha' },
      { approvalRequestId: 'approval-ext' }
    );
    expect(applied.mock.calls.flat().join('')).toContain('"status":"extended"');
  });
  it('refuses to extend a grant that is not a credential allocation of the tenant', async () => {
    await expect(
      runCredentialAllocationCommand(['extend', '--tenant', 'alpha', '--grant', 'GRT-x'], () => {})
    ).rejects.toThrow('Credential allocation not found');
    expect(mocks.requestExtension).not.toHaveBeenCalled();
  });

  it('requests hash-bound approval by default and does not grant or collect a key', async () => {
    mocks.request.mockReturnValue({ id: 'approval-test' });
    const print = vi.fn();
    expect(await runCredentialAllocationCommand(assign, print)).toBe(0);
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'credential.use',
        tenant_slug: 'alpha',
        credential_provider: 'anthropic',
        ttl_days: 7,
      }),
      expect.any(Object)
    );
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(print.mock.calls.flat().join('')).toContain('approval_required');
  });
  it('applies only through the existing approved standing grant path', async () => {
    mocks.grant.mockReturnValue({ grant_id: 'GRT-test', expires_at: 'future' });
    await runCredentialAllocationCommand([...assign, '--approval', 'approval-test'], () => {});
    expect(mocks.grant).toHaveBeenCalledWith(
      expect.objectContaining({ credential_provider: 'anthropic' }),
      { approvalRequestId: 'approval-test' }
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('resumes the same assignment after a browser decision without replaying approval options', async () => {
    const print = vi.fn();
    mocks.request.mockReturnValueOnce({
      id: 'approval-inbox',
      status: 'pending',
      scope: { tier: 'confidential', tenant_slug: 'alpha' },
    });
    await runCredentialAllocationCommand(assign, print);
    expect(JSON.parse(print.mock.calls[0]![0]).next[0]).toContain('/inbox?reason=approval');
    expect(mocks.grant).not.toHaveBeenCalled();

    mocks.request.mockReturnValueOnce({ id: 'approval-inbox', status: 'approved' });
    mocks.grant.mockReturnValue({ grant_id: 'GRT-inbox', expires_at: 'future' });
    await runCredentialAllocationCommand(assign, print);
    expect(mocks.grant).toHaveBeenCalledWith(expect.objectContaining({ tenant_slug: 'alpha' }), {
      approvalRequestId: 'approval-inbox',
    });
    expect(JSON.parse(print.mock.calls[1]![0])).toMatchObject({ status: 'allocated' });
  });
  it('lends a credential_ref with terms from the registered record through the same approval path', async () => {
    const { buildCredentialRecord } = await import('@agent/core/secret/credential-allocations');
    mocks.readRecord.mockImplementation((_tenant: string, ref: string) =>
      buildCredentialRecord({
        credentialRef: ref,
        value: 'sk-ant-registered-0001',
        registeredBy: 'user:cfo',
        ...(ref.includes('claude-subscription') ? { plan: 'pro' } : {}),
      })
    );
    mocks.request.mockReturnValue({ id: 'approval-lend' });
    const print = vi.fn();
    const lend = [
      'assign',
      '--tenant',
      'alpha',
      '--credential',
      'tenant:parent:anthropic',
      '--backends',
      'claude-cli,anthropic',
      '--budget-usd',
      '400',
      '--purpose',
      'subsidiary dot',
    ];
    expect(await runCredentialAllocationCommand(lend, print)).toBe(0);
    expect(mocks.readRecord).toHaveBeenCalledWith('alpha', 'tenant:parent:anthropic');
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        credential_provider: 'anthropic',
        credential_ref: 'anthropic/API_KEY',
        credential_lending: expect.objectContaining({
          credential_ref: 'tenant:parent:anthropic',
          kind: 'api_key',
          allowed_backends: ['anthropic', 'claude-cli'],
          budget_monthly_usd: 400,
          value_fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        }),
      }),
      expect.any(Object)
    );
    expect(print.mock.calls.flat().join('')).toContain('an owner of tenant parent');
    // Flags never override the record: a mismatching --plan is refused.
    await expect(
      runCredentialAllocationCommand(
        [
          'assign',
          '--tenant',
          'alpha',
          '--credential',
          'person:owner:claude-subscription',
          '--plan',
          'max',
          '--purpose',
          'x',
        ],
        () => {}
      )
    ).rejects.toThrow(/CREDENTIAL_RECORD_MISMATCH/);
  });
  it('registers a tenant-custody key through the broker without printing it', async () => {
    mocks.registerTenant.mockReturnValue({
      status: 'registered',
      credential_ref: 'tenant:alpha:anthropic',
      path: 'knowledge/confidential/alpha/connections/anthropic.json',
      kind: 'api_key',
      plan: 'api',
    });
    const print = vi.fn();
    const args = ['register', '--custody', 'tenant', '--owner', 'alpha', '--service', 'anthropic'];
    expect(await runCredentialAllocationCommand(args, print)).toBe(0);
    expect(mocks.registerTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialRef: 'tenant:alpha:anthropic',
        value: 'sk-ant-collected-0001',
        registeredBy: 'user:owner',
      })
    );
    expect(print.mock.calls.flat().join('')).not.toContain('sk-ant-collected');
  });
  it('registers a person Pro setup-token through the personal secret introduction', async () => {
    mocks.introduce.mockResolvedValue({ phase: 'applied', status: 'applied' });
    mocks.registerPerson.mockReturnValue({
      kind: 'subscription_token',
      plan: 'pro',
      value_fingerprint: 'sha256:' + '0'.repeat(64),
    });
    const print = vi.fn();
    const args = [
      'register',
      '--custody',
      'person',
      '--service',
      'claude-subscription',
      '--plan',
      'pro',
    ];
    expect(await runCredentialAllocationCommand(args, print)).toBe(0);
    expect(mocks.introduce.mock.calls[0]![0].slice(0, 3)).toEqual([
      'introduce',
      'claude-subscription',
      'OAUTH_TOKEN',
    ]);
    expect(mocks.registerPerson).toHaveBeenCalledWith(
      expect.objectContaining({ credentialRef: 'person:owner:claude-subscription', plan: 'pro' })
    );
    expect(print.mock.calls.flat().join('')).toContain('person:owner:claude-subscription');
  });
  it('reports monthly usage and budget per credential', async () => {
    mocks.summarize.mockReturnValue([{ credential_ref: 'tenant:parent:anthropic', runs: 3 }]);
    mocks.list.mockReturnValue([
      {
        grant_id: 'GRT-u',
        scope: {
          credential_lending: {
            credential_ref: 'tenant:parent:anthropic',
            budget_monthly_usd: 100,
          },
        },
      },
    ]);
    const print = vi.fn();
    expect(
      await runCredentialAllocationCommand(
        ['usage', '--tenant', 'alpha', '--month', '2026-11'],
        print
      )
    ).toBe(0);
    expect(mocks.summarize).toHaveBeenCalledWith('alpha', '2026-11');
    const out = JSON.parse(print.mock.calls[0]![0]);
    expect(out.budgets[0]).toMatchObject({ grant_id: 'GRT-u', status: 'warn' });
  });
  it('reports a missing local allocation without issuing an API request', async () => {
    const print = vi.fn();
    expect(
      await runCredentialAllocationCommand(
        ['check', '--tenant', 'alpha', '--provider', 'anthropic'],
        print
      )
    ).toBe(1);
    expect(print.mock.calls.flat().join('')).toContain('"allocated":false');
    expect(mocks.probe).not.toHaveBeenCalled();
  });
  it('rejects cross-tenant administration before touching grants', async () => {
    await withExecutionContextAsync(
      'reasoning_credentials',
      async () => {
        await expect(runCredentialAllocationCommand(assign, () => {})).rejects.toThrow(
          'Cross-tenant'
        );
      },
      undefined,
      'beta'
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('requires explicit billing consent and delegates probes to claimed WorkItem execution', async () => {
    mocks.probe.mockResolvedValue({ status: 'succeeded', proof: { status: 'success' } });
    const args = [
      'probe',
      '--tenant',
      'alpha',
      '--provider',
      'anthropic',
      '--mission',
      'MSN-TEST',
      '--model',
      'test-model',
    ];
    await expect(runCredentialAllocationCommand(args, () => {})).rejects.toThrow('--allow-paid');
    expect(mocks.probe).not.toHaveBeenCalled();
    await runCredentialAllocationCommand([...args, '--allow-paid'], () => {});
    expect(mocks.probe).toHaveBeenLastCalledWith(expect.objectContaining({ allowPaid: true }));
  });
});

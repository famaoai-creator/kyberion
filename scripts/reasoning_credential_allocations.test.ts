import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContextAsync } from '@agent/core/authority';
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  list: vi.fn(),
  probe: vi.fn(),
}));
vi.mock('@agent/core/governance/grant-store', () => ({
  requestGrantApproval: mocks.request,
  grantStanding: mocks.grant,
  revokeGrant: mocks.revoke,
  grantStatusAt: () => 'active',
  verifyGrantBasis: () => true,
}));
vi.mock('@agent/core/secret/credential-allocations', () => ({
  CREDENTIAL_USE_CAPABILITY: 'credential.use',
  listCredentialAllocations: mocks.list,
  assertCredentialAllocation: vi.fn(),
}));
vi.mock('./reasoning_credential_probe.js', () => ({ probeAllocatedCredential: mocks.probe }));
vi.mock('@agent/core/organization/tenant-registry', () => ({
  readTenantProfile: () => ({ tenant_slug: 'alpha', status: 'active' }),
}));
vi.mock('@agent/core/governance/cli-operator-principal', () => ({
  resolveCliApprovalRequester: () => ({ requestedBy: 'user:test' }),
}));
vi.mock('./cli-grants.js', () => ({ resolveRevoker: () => ({ kind: 'human', id: 'user:test' }) }));
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

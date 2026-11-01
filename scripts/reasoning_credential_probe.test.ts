import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  delegate: vi.fn(),
  proof: vi.fn(),
  list: vi.fn(),
  mission: vi.fn(),
  envelope: vi.fn(),
  mint: vi.fn(),
}));
vi.mock('@agent/core/workforce/work-coordination', () => ({ createWorkItem: mocks.create }));
vi.mock('@agent/core/coordinated-agent-execution-port', () => ({
  delegateCoordinatedCliSubagentTask: mocks.delegate,
}));
vi.mock('@agent/core/mission/mission-state-reader', () => ({
  readMissionStateAtPath: mocks.mission,
}));
vi.mock('@agent/core/path-resolver', async (original) => ({
  ...(await original<typeof import('@agent/core/path-resolver')>()),
  missionDir: () => '/repo/active/missions/confidential/alpha/MSN-PROBE',
}));
vi.mock('@agent/core/scope-envelope', async (original) => ({
  ...(await original<typeof import('@agent/core/scope-envelope')>()),
  currentScopeEnvelope: mocks.envelope,
  mintScopeEnvelope: mocks.mint,
  withScopeEnvelope: (_envelope: unknown, run: () => unknown) => run(),
}));
vi.mock('@agent/core/secret/credential-allocations', () => ({
  listCredentialAllocations: mocks.list,
  assertCredentialAllocation: vi.fn(),
  installLocalCredentialAllocations: vi.fn(),
}));
vi.mock('@agent/core/secret/secret-resolver', () => ({
  getSecretResolver: () => ({ name: 'local-credential-allocations' }),
  installSecretResolverIfAvailable: vi.fn(),
}));
vi.mock('@agent/core/reasoning/reasoning-api-credentials', async (original) => ({
  ...(await original<typeof import('@agent/core/reasoning/reasoning-api-credentials')>()),
  verifyReasoningApiCredential: mocks.proof,
}));
import { probeAllocatedCredential } from './reasoning_credential_probe.js';
const options = {
  tenant: 'alpha',
  provider: 'anthropic',
  mission: 'MSN-PROBE',
  model: 'test-model',
  allowPaid: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.envelope.mockReturnValue(null);
  mocks.mint.mockImplementation((x) => x);
  mocks.list.mockReturnValue([{ grant_id: 'GRT-test' }]);
  mocks.create.mockReturnValue({ item_id: 'WI-probe' });
  mocks.mission.mockReturnValue({
    mission_id: 'MSN-PROBE',
    tenant_slug: 'alpha',
    status: 'active',
    relationships: { organization: { organization_id: 'org-a' }, project: { project_id: 'PRJ-A' } },
  });
  mocks.proof.mockResolvedValue({
    provider: 'anthropic',
    model: 'test-model',
    status: 'success',
    code: 'verified',
  });
  mocks.delegate.mockImplementation(async (_request, run) => run());
});
describe('tenant task credential probe assembly', () => {
  it('creates a ready WorkItem with the same explicit entity chain passed into claimed dispatch', async () => {
    const result = await probeAllocatedCredential(options);
    expect(result).toMatchObject({
      work_item_id: 'WI-probe',
      status: 'succeeded',
      proof: { code: 'verified' },
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ready',
        projectId: 'PRJ-A',
        context: expect.objectContaining({
          tenant_slug: 'alpha',
          organization_id: 'org-a',
          project_id: 'PRJ-A',
          mission_id: 'MSN-PROBE',
        }),
      })
    );
    const request = mocks.delegate.mock.calls[0][0];
    expect(request.security_scope).toMatchObject({
      tenant_slug: 'alpha',
      organization_id: 'org-a',
      project_id: 'PRJ-A',
      mission_id: 'MSN-PROBE',
    });
    expect(request.task_id).toBe(mocks.create.mock.calls[0][0].context.task_id);
    expect(mocks.proof).toHaveBeenCalledWith({
      provider: 'anthropic',
      model: 'test-model',
      allowPaid: true,
    });
  });
  it('refuses absent billing consent before creating work or contacting the API', async () => {
    await expect(probeAllocatedCredential({ ...options, allowPaid: false })).rejects.toThrow(
      '--allow-paid'
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.proof).not.toHaveBeenCalled();
  });
  it('refuses missing local allocation and unrelated task envelopes before creating work', async () => {
    mocks.list.mockReturnValue([]);
    await expect(probeAllocatedCredential(options)).rejects.toThrow('CREDENTIAL_ALLOCATION_DENIED');
    mocks.list.mockReturnValue([{ grant_id: 'GRT-test' }]);
    mocks.envelope.mockReturnValue({ identity: {} });
    await expect(probeAllocatedCredential(options)).rejects.toThrow(
      'outside an existing task envelope'
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('rejects another tenant mission and a mission without explicit organization/project linkage', async () => {
    mocks.mission.mockReturnValue({
      mission_id: 'MSN-PROBE',
      tenant_slug: 'beta',
      status: 'active',
    });
    await expect(probeAllocatedCredential(options)).rejects.toThrow('selected tenant');
    mocks.mission.mockReturnValue({
      mission_id: 'MSN-PROBE',
      tenant_slug: 'alpha',
      status: 'active',
    });
    await expect(probeAllocatedCredential(options)).rejects.toThrow(
      'linked to an organization and project'
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

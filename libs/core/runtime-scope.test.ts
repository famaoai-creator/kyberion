import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAgentIdentity: vi.fn(),
}));

vi.mock('./agent-identity.js', () => ({
  getAgentIdentity: mocks.getAgentIdentity,
}));

describe('runtime-scope', () => {
  beforeEach(() => {
    mocks.getAgentIdentity.mockReset();
  });

  it('assigns explicit system scope to a process-only runtime request', async () => {
    const { resolveRuntimeScope } = await import('./runtime-scope.js');
    expect(resolveRuntimeScope()).toEqual({ scope_kind: 'system', tier: 'public' });
  });

  it('normalizes an explicit task scope without inferring a tenant', async () => {
    const { resolveRuntimeScope } = await import('./runtime-scope.js');
    expect(
      resolveRuntimeScope({
        missionId: 'msn-a',
        scope: {
          scope_kind: 'task',
          tier: 'confidential',
          tenant_slug: 'tenant-a',
          mission_id: 'MSN-A',
          task_id: 'TASK-A',
        },
      })
    ).toMatchObject({
      scope_kind: 'task',
      tier: 'confidential',
      tenant_slug: 'tenant-a',
      mission_id: 'MSN-A',
      task_id: 'TASK-A',
    });
  });

  it('fails closed when a mission request has no authoritative scope', async () => {
    const { resolveRuntimeScope } = await import('./runtime-scope.js');
    expect(() => resolveRuntimeScope({ missionId: 'MSN-NOT-REGISTERED' })).toThrow(
      '[RUNTIME_SCOPE_REQUIRED]'
    );
  });

  it('rejects a supplied scope that changes the authoritative mission', async () => {
    const { resolveRuntimeScope } = await import('./runtime-scope.js');
    expect(() =>
      resolveRuntimeScope({
        missionId: 'MSN-A',
        authorityScope: {
          scope_kind: 'mission',
          tier: 'confidential',
          tenant_slug: 'tenant-a',
          mission_id: 'MSN-A',
        },
        scope: {
          scope_kind: 'task',
          tier: 'confidential',
          tenant_slug: 'tenant-b',
          mission_id: 'MSN-A',
          task_id: 'TASK-B',
        },
      })
    ).toThrow('[EVENT_SCOPE_LINEAGE_CONFLICT]');
  });

  it('rejects an NHI affiliated with another tenant', async () => {
    mocks.getAgentIdentity.mockReturnValue({
      nhi_id: 'nhi://org/agent-a',
      affiliation: { organization_id: 'org', tenant_slug: 'tenant-a' },
    });
    const { assertRuntimeNhiScope } = await import('./runtime-scope.js');
    expect(() =>
      assertRuntimeNhiScope({
        scope_kind: 'mission',
        tier: 'confidential',
        tenant_slug: 'tenant-b',
        mission_id: 'MSN-B',
        nhi_id: 'nhi://org/agent-a',
      })
    ).toThrow('[RUNTIME_NHI_TENANT_MISMATCH]');
  });
});

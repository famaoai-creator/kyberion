import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAgentIdentity: vi.fn(),
  findMissionPath: vi.fn(),
  safeExistsSync: vi.fn(),
  loadJson: vi.fn(),
  loadProjectRecord: vi.fn(),
}));

vi.mock('../agent/agent-identity.js', () => ({
  getAgentIdentity: mocks.getAgentIdentity,
}));
vi.mock('../path-resolver.js', () => ({
  findMissionPath: mocks.findMissionPath,
}));
vi.mock('../mission/mission-state-reader.js', () => ({
  loadMissionStateAtPath: mocks.loadJson,
}));
vi.mock('../secure-io.js', () => ({
  assertSafeRepositoryPath: (filePath: string) => filePath,
  safeExistsSync: mocks.safeExistsSync,
  loadJson: mocks.loadJson,
}));
vi.mock('../foundation/json.js', () => ({
  readJson: <T>(filePath: string): T => mocks.loadJson(filePath) as T,
}));
vi.mock('../project/project-registry.js', () => ({
  loadProjectRecord: mocks.loadProjectRecord,
}));

describe('runtime-scope', () => {
  beforeEach(() => {
    mocks.getAgentIdentity.mockReset();
    mocks.findMissionPath.mockReset();
    mocks.safeExistsSync.mockReset();
    mocks.loadJson.mockReset();
    mocks.loadProjectRecord.mockReset();
    mocks.findMissionPath.mockReturnValue(null);
    mocks.safeExistsSync.mockReturnValue(false);
    mocks.loadProjectRecord.mockReturnValue(null);
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

  it('resolves organization scope from the canonical project registry for a linked mission', async () => {
    mocks.findMissionPath.mockReturnValue('/repo/active/missions/MSN-REGISTRY-SCOPE');
    mocks.safeExistsSync.mockReturnValue(true);
    mocks.loadJson.mockReturnValue({
      mission_id: 'MSN-REGISTRY-SCOPE',
      tier: 'confidential',
      tenant_slug: 'tenant-a',
      relationships: { project: { project_id: 'PRJ-REGISTRY-SCOPE' } },
    });
    mocks.loadProjectRecord.mockReturnValue({
      project_id: 'PRJ-REGISTRY-SCOPE',
      name: 'Registry scope fixture',
      summary: 'Registry scope fixture.',
      status: 'active',
      tier: 'confidential',
      tenant_slug: 'tenant-a',
      organization_id: 'org-a',
    });

    const { resolveRuntimeScope } = await import('./runtime-scope.js');
    expect(resolveRuntimeScope({ missionId: 'MSN-REGISTRY-SCOPE' })).toMatchObject({
      scope_kind: 'mission',
      tier: 'confidential',
      tenant_slug: 'tenant-a',
      organization_id: 'org-a',
      project_id: 'PRJ-REGISTRY-SCOPE',
      mission_id: 'MSN-REGISTRY-SCOPE',
    });
  });

  it('drops a legacy project reference that has no resolvable organization', async () => {
    // Mission state written before the containment chain existed: a project
    // relationship with neither an organization on the mission nor a registry
    // record to resolve one from. Contributing the bare project_id produced a
    // scope that failed containment validation, which blocked every CLI verb
    // that resolves the process scope during bootstrap — including repair.
    mocks.findMissionPath.mockReturnValue('/repo/active/missions/MSN-LEGACY-CHAIN');
    mocks.safeExistsSync.mockReturnValue(true);
    mocks.loadJson.mockReturnValue({
      mission_id: 'MSN-LEGACY-CHAIN',
      tier: 'confidential',
      tenant_slug: 'tenant-a',
      relationships: { project: { project_id: 'PRJ-UNREGISTERED' } },
    });
    mocks.loadProjectRecord.mockReturnValue(null);

    const { resolveRuntimeScope } = await import('./runtime-scope.js');
    const scope = resolveRuntimeScope({ missionId: 'MSN-LEGACY-CHAIN' });
    expect(scope.tenant_slug).toBe('tenant-a');
    expect(scope.organization_id).toBeUndefined();
    expect(scope.project_id).toBeUndefined();
  });

  it('drops an organization that has no tenant above it', async () => {
    // A public-tier mission may legitimately have no tenant. An organization
    // recorded without one still cannot be honoured: organizations live inside
    // tenants, so the id has nothing to scope against.
    mocks.findMissionPath.mockReturnValue('/repo/active/missions/MSN-ORPHAN-ORG');
    mocks.safeExistsSync.mockReturnValue(true);
    mocks.loadJson.mockReturnValue({
      mission_id: 'MSN-ORPHAN-ORG',
      tier: 'public',
      organization_id: 'org-a',
      relationships: { project: { project_id: 'PRJ-ORPHAN' } },
    });
    mocks.loadProjectRecord.mockReturnValue(null);

    const { resolveRuntimeScope } = await import('./runtime-scope.js');
    const scope = resolveRuntimeScope({ missionId: 'MSN-ORPHAN-ORG' });
    expect(scope.tenant_slug).toBeUndefined();
    expect(scope.organization_id).toBeUndefined();
    expect(scope.project_id).toBeUndefined();
  });

  it('still fails closed for a confidential mission with no tenant', async () => {
    // Gating the chain must not soften the tenant invariant: confidential work
    // without a tenant has no isolation boundary and must not resolve.
    mocks.findMissionPath.mockReturnValue('/repo/active/missions/MSN-NO-TENANT');
    mocks.safeExistsSync.mockReturnValue(true);
    mocks.loadJson.mockReturnValue({
      mission_id: 'MSN-NO-TENANT',
      tier: 'confidential',
      relationships: { project: { project_id: 'PRJ-ORPHAN' } },
    });
    mocks.loadProjectRecord.mockReturnValue(null);

    const { resolveRuntimeScope } = await import('./runtime-scope.js');
    expect(() => resolveRuntimeScope({ missionId: 'MSN-NO-TENANT' })).toThrow(
      '[SCOPE_CONTEXT_INVALID]'
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

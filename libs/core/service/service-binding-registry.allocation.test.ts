import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceBindingRecord } from './service-binding-registry.js';
import type { ContextSecurityScope } from '../governance/context-security-scope.js';
const mocks = vi.hoisted(() => ({
  allocation: vi.fn(),
  load: vi.fn(),
  project: vi.fn(),
  mission: vi.fn(),
}));
vi.mock('../foundation/governed-catalog.js', () => ({
  defineCatalog: () => ({ load: mocks.load }),
}));
vi.mock('../path-resolver.js', () => ({
  pathResolver: {
    shared: (p: string) => `/synthetic/${p}`,
    knowledge: (p: string) => `/synthetic/${p}`,
  },
  findMissionPath: () => '/synthetic/mission',
}));
vi.mock('../foundation/env.js', () => ({ getRegisteredEnvText: () => 'MSN-A' }));
vi.mock('../secure-io.js', () => ({
  assertSafeRepositoryPath: (p: string) => p,
  safeExistsSync: () => true,
  safeReaddir: () => ['personal-slack.json'],
  safeMkdir: vi.fn(),
  safeReadFile: vi.fn(),
  safeWriteFile: vi.fn(),
}));
vi.mock('../project/project-registry.js', () => ({ loadProjectRecord: mocks.project }));
vi.mock('../organization/tenant-registry.js', () => ({ resolveTenant: () => ({ slug: 'acme' }) }));
vi.mock('../mission/mission-state-reader.js', () => ({ loadMissionStateAtPath: mocks.mission }));
vi.mock('../governance/service-credential-allocation.js', () => ({
  assertServiceCredentialAllocation: mocks.allocation,
}));
vi.mock('../governance/context-security-scope.js', () => ({
  validateContextSecurityScope: () => [],
  resolveTenantAlias: (scope: { tenant_slug?: string }) => scope.tenant_slug,
}));
import { authorizeTenantServiceAction } from './service-binding-registry.js';
const scope: ContextSecurityScope = {
  tenant_slug: 'acme',
  project_id: 'project-a',
  mission_id: 'MSN-A',
  task_id: 'task-a',
  read_tiers: ['confidential'],
  write_tier: 'confidential',
  purpose: 'test allocation',
};
const personal: ServiceBindingRecord = {
  binding_id: 'personal-slack',
  service_type: 'slack',
  service_id: 'slack',
  scope: 'personal',
  target: 'workspace:acme',
  owner_kind: 'person',
  owner_ref: 'user:alice',
  auth_mode: 'secret-guard',
  secret_refs: ['SLACK_TOKEN'],
  allowed_actions: ['read'],
  approval_policy: { read: 'allowed' },
};
const request = {
  serviceId: 'slack',
  action: 'read',
  securityScope: scope,
  bindingId: personal.binding_id,
};
describe('tenant service admission of explicitly allocated personal connections', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.load.mockReturnValue(personal);
    mocks.project.mockReturnValue({
      status: 'active',
      tenant_slug: 'acme',
      service_bindings: [personal.binding_id],
    });
    mocks.mission.mockReturnValue({
      status: 'active',
      tenant_slug: 'acme',
      relationships: { project: { project_id: 'project-a' } },
    });
    mocks.allocation.mockReturnValue({ grant_id: 'synthetic-grant' });
  });
  it('passes selected record, exact tenant/work scope and action to owner-grant verification', () => {
    expect(authorizeTenantServiceAction(request)).toEqual({
      bindingId: personal.binding_id,
      approvalRequired: false,
    });
    expect(mocks.allocation).toHaveBeenCalledWith(
      personal,
      { tenant_slug: 'acme', project_id: 'project-a', mission_id: 'MSN-A', task_id: 'task-a' },
      { action: 'read' }
    );
  });
  it('never discovers a personal connection as a tenant default', () => {
    expect(() => authorizeTenantServiceAction({ ...request, bindingId: undefined })).toThrow(
      'No tenant/project service binding'
    );
    expect(mocks.allocation).not.toHaveBeenCalled();
  });
  it('denies absent/revoked owner allocation', () => {
    mocks.allocation.mockImplementation(() => {
      throw new Error('SERVICE_CREDENTIAL_ALLOCATION_DENIED');
    });
    expect(() => authorizeTenantServiceAction(request)).toThrow(
      'No tenant/project service binding'
    );
  });
  it('does not let owner allocation override the binding action allowlist', () => {
    expect(() => authorizeTenantServiceAction({ ...request, action: 'write' })).toThrow(
      'No tenant/project service binding'
    );
    expect(mocks.allocation).toHaveBeenCalledWith(personal, expect.anything(), { action: 'write' });
  });
  it('does not let owner allocation bypass project assignment', () => {
    mocks.project.mockReturnValue({ status: 'active', tenant_slug: 'acme', service_bindings: [] });
    expect(() => authorizeTenantServiceAction(request)).toThrow(
      'No tenant/project service binding'
    );
  });
  it('preserves denied and approval-required effect policy separately from credential consent', () => {
    mocks.load.mockReturnValue({ ...personal, approval_policy: { read: 'denied' } });
    expect(() => authorizeTenantServiceAction(request)).toThrow('denies read');
    mocks.load.mockReturnValue({ ...personal, approval_policy: { read: 'approval_required' } });
    expect(authorizeTenantServiceAction(request)).toEqual({
      bindingId: personal.binding_id,
      approvalRequired: true,
    });
  });
  it('rejects session-mode personal connections even with a matching grant', () => {
    mocks.load.mockReturnValue({ ...personal, auth_mode: 'session' });
    expect(() => authorizeTenantServiceAction(request)).toThrow(
      'No tenant/project service binding'
    );
    expect(mocks.allocation).not.toHaveBeenCalled();
  });
});

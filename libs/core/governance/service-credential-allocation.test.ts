import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrantRecord } from './grant-store.js';
import type { ServiceBindingRecord } from '../service/service-binding-registry.js';
const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  list: vi.fn(),
  load: vi.fn(),
  status: vi.fn(),
  verify: vi.fn(),
  store: vi.fn(),
}));
vi.mock('../authority.js', () => ({ withStoreGrant: mocks.store }));
vi.mock('../foundation/credential-binding.js', () => ({
  credentialExecutionIdentity: mocks.identity,
}));
vi.mock('./grant-store.js', () => ({
  listGrants: mocks.list,
  loadGrant: mocks.load,
  grantStatusAt: mocks.status,
  verifyGrantBasis: mocks.verify,
}));
import { verifyServiceCredentialAllocation as assertServiceCredentialAllocation } from './service-credential-allocation-verifier.js';
const scope = {
  tenant_slug: 'acme',
  project_id: 'project-a',
  mission_id: 'MSN-A',
  task_id: 'task-a',
};
const binding = {
  binding_id: 'personal-slack',
  target: 'workspace:acme',
  owner_kind: 'person',
  owner_ref: 'user:alice',
  service_id: 'slack',
  service_type: 'slack',
  auth_mode: 'secret-guard',
  secret_refs: ['SLACK_TOKEN'],
  allowed_actions: ['read', 'write'],
  approval_policy: { read: 'allowed', write: 'allowed' },
} as ServiceBindingRecord;
function grant(): GrantRecord {
  return {
    grant_id: 'GRT-test',
    capability: 'credential.use',
    scope: {
      tenant_slug: 'acme',
      service_allocation: {
        binding_id: binding.binding_id,
        target: binding.target,
        owner_ref: 'user:alice',
        service_id: 'slack',
        secret_refs: ['SLACK_TOKEN'],
        allowed_actions: ['read'],
        project_id: 'project-a',
        mission_id: 'MSN-A',
        task_id: 'task-a',
      },
    },
  } as GrantRecord;
}
describe('personal service allocation admission', () => {
  let current: GrantRecord;
  beforeEach(() => {
    vi.resetAllMocks();
    current = grant();
    mocks.identity.mockReturnValue({ tenantSlug: 'acme', missionId: 'MSN-A', taskId: 'task-a' });
    mocks.list.mockImplementation(() => [current]);
    mocks.load.mockImplementation(() => current);
    mocks.status.mockReturnValue('active');
    mocks.verify.mockReturnValue(true);
    mocks.store.mockImplementation((_name: string, run: () => unknown) => run());
  });
  it('admits exactly one verified owner grant and narrows store authority to current task', () => {
    expect(assertServiceCredentialAllocation(binding, scope, { action: 'read' })).toBe(current);
    expect(mocks.verify).toHaveBeenCalledWith(current);
    expect(mocks.store).toHaveBeenCalledWith('credential_allocation_reader', expect.any(Function), {
      tenantSlug: 'acme',
      identity: { missionId: 'MSN-A', taskId: 'task-a' },
    });
  });
  it('loads an explicitly selected grant without searching for a fallback', () => {
    expect(assertServiceCredentialAllocation(binding, scope, { grantId: 'GRT-test' })).toBe(
      current
    );
    expect(mocks.load).toHaveBeenCalledWith('acme', 'GRT-test');
    expect(mocks.list).not.toHaveBeenCalled();
    mocks.load.mockReturnValue(null);
    expect(() => assertServiceCredentialAllocation(binding, scope, { grantId: 'missing' })).toThrow(
      'ALLOCATION_DENIED'
    );
  });
  it.each(['tenantSlug', 'missionId', 'taskId'])(
    'rejects missing or mismatched trusted %s',
    (key) => {
      for (const value of [undefined, 'other']) {
        mocks.identity.mockReturnValue({
          tenantSlug: 'acme',
          missionId: 'MSN-A',
          taskId: 'task-a',
          [key]: value,
        });
        expect(() => assertServiceCredentialAllocation(binding, scope)).toThrow(
          'ALLOCATION_DENIED'
        );
      }
      expect(mocks.store).not.toHaveBeenCalled();
    }
  );
  it.each([
    { owner_kind: 'organization', tenant_slug: 'acme', owner_ref: 'acme' },
    { owner_kind: 'operator', owner_ref: undefined },
    { owner_ref: undefined },
    { owner_ref: 'user:bob' },
    { tenant_slug: 'acme' },
  ])('rejects invalid or drifted personal ownership %j', (change) => {
    expect(() =>
      assertServiceCredentialAllocation({ ...binding, ...change } as ServiceBindingRecord, scope)
    ).toThrow('ALLOCATION_DENIED');
  });
  it.each([
    'binding_id',
    'target',
    'target',
    'owner_ref',
    'service_id',
    'project_id',
    'mission_id',
    'task_id',
  ])('rejects allocation %s mismatch', (key) => {
    Object.assign(current.scope.service_allocation!, { [key]: 'other' });
    expect(() => assertServiceCredentialAllocation(binding, scope)).toThrow('ALLOCATION_DENIED');
  });
  it.each([['OTHER_TOKEN'], ['SLACK_TOKEN', 'OTHER_TOKEN'], []])(
    'requires exact credential refs %j',
    (...refs) => {
      current.scope.service_allocation!.secret_refs = refs;
      expect(() => assertServiceCredentialAllocation(binding, scope)).toThrow('ALLOCATION_DENIED');
    }
  );
  it('rejects actions outside owner grant and capabilities removed from binding', () => {
    expect(() => assertServiceCredentialAllocation(binding, scope, { action: 'write' })).toThrow(
      'ALLOCATION_DENIED'
    );
    expect(() =>
      assertServiceCredentialAllocation({ ...binding, allowed_actions: ['write'] }, scope)
    ).toThrow('ALLOCATION_DENIED');
  });
  it('rejects wrong capability/tenant and missing allocation', () => {
    for (const change of [
      { capability: 'other' },
      { scope: { ...current.scope, tenant_slug: 'other' } },
      { scope: { tenant_slug: 'acme' } },
    ]) {
      mocks.list.mockReturnValue([{ ...current, ...change }]);
      expect(() => assertServiceCredentialAllocation(binding, scope)).toThrow('ALLOCATION_DENIED');
    }
  });
  it('rechecks expiry and approval revocation each use; metadata is not authority', () => {
    expect(assertServiceCredentialAllocation(binding, scope)).toBe(current);
    mocks.status.mockReturnValue('expired');
    expect(() => assertServiceCredentialAllocation(binding, scope)).toThrow('ALLOCATION_DENIED');
    mocks.status.mockReturnValue('active');
    mocks.verify.mockReturnValue(false);
    expect(() =>
      assertServiceCredentialAllocation(
        { ...binding, metadata: { owner_approved: true, allocation_grant_id: current.grant_id } },
        scope
      )
    ).toThrow('ALLOCATION_DENIED');
  });
  it.each([undefined, '', 'bad/tenant', 'personal', 'shared'])(
    'rejects invalid tenant even when runtime agrees: %s',
    (tenant) => {
      mocks.identity.mockReturnValue({ tenantSlug: tenant, missionId: 'MSN-A', taskId: 'task-a' });
      current.scope.tenant_slug = tenant as string;
      expect(() =>
        assertServiceCredentialAllocation(binding, { ...scope, tenant_slug: tenant as string })
      ).toThrow();
      expect(mocks.store).not.toHaveBeenCalled();
    }
  );
  it('denies absent and ambiguous grants', () => {
    for (const records of [[], [current, { ...current, grant_id: 'another' }]]) {
      mocks.list.mockReturnValue(records);
      expect(() => assertServiceCredentialAllocation(binding, scope)).toThrow('ALLOCATION_DENIED');
    }
  });
});

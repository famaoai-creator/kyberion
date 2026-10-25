import { afterEach, describe, expect, it, vi } from 'vitest';
const resolveTenant = vi.hoisted(() => vi.fn());
vi.mock('./organization/tenant-registry.js', async (original) => ({
  ...(await original<typeof import('./organization/tenant-registry.js')>()),
  resolveTenant,
}));
import { resolveIdentityContext, withExecutionContext } from './authority.js';
import { isRegisteredOperationalTenant } from './foundation/operational-store-policy.js';
import { assertRecordIdentity } from './organization/organization-operating-model-persistence.js';
import { withOpsAlertFileStore } from './ops-alert-log.js';
import { defaultOpsAlertLogPath } from './ops-alert.js';
import { pathResolver } from './path-resolver.js';

afterEach(() => {
  vi.unstubAllEnvs();
  resolveTenant.mockReset();
});
describe('bounded operational store authority', () => {
  it('checks tenant registration as its bounded system reader, without returning the private profile', () => {
    vi.stubEnv('KYBERION_ENTITY_GOVERNANCE', 'enforce');
    const seen: Array<{ role?: string; tenant?: string }> = [];
    resolveTenant.mockImplementation(() => {
      const identity = resolveIdentityContext();
      seen.push({ role: identity.role, tenant: identity.tenantSlug });
      return { profile: { private_metadata: 'must not escape' } };
    });
    withExecutionContext(
      'operational_learning_writer',
      () => {
        expect(isRegisteredOperationalTenant('acme')).toBe(true);
        expect(() =>
          assertRecordIdentity({ organization_id: 'org-1', tier: 'personal', tenant_slug: 'acme' })
        ).not.toThrow();
        expect(resolveIdentityContext().role).toBe('operational_learning_writer');
        expect(() => isRegisteredOperationalTenant('other')).toThrow('ROLE_TENANT_SCOPE_MISMATCH');
      },
      'worker',
      'acme'
    );
    expect(seen).toEqual([
      { role: 'workspace_tenant_registry_reader', tenant: 'acme' },
      { role: 'workspace_tenant_registry_reader', tenant: 'acme' },
    ]);
  });
  it('keeps missing or suspended tenants fail closed', () => {
    resolveTenant.mockImplementation(() => {
      throw new Error('tenant inactive');
    });
    withExecutionContext(
      'operational_learning_writer',
      () => {
        expect(() => isRegisteredOperationalTenant('acme')).toThrow('tenant inactive');
      },
      'worker',
      'acme'
    );
  });
  it('assumes the alert writer only for exact default store files and restores the caller', () => {
    withExecutionContext(
      'run_pipeline.bundle',
      () => {
        expect(
          withOpsAlertFileStore(defaultOpsAlertLogPath(), () => resolveIdentityContext().role)
        ).toBe('ops_alert_store');
        expect(
          withOpsAlertFileStore(
            defaultOpsAlertLogPath().replace('.jsonl', '.dedupe.json'),
            () => resolveIdentityContext().role
          )
        ).toBe('ops_alert_store');
        expect(
          withOpsAlertFileStore(
            pathResolver.sharedTmp('custom-ops-alert.jsonl'),
            () => resolveIdentityContext().role
          )
        ).toBe('run_pipeline.bundle');
        expect(
          withOpsAlertFileStore(
            pathResolver.rootResolve('knowledge/personal/secret.json'),
            () => resolveIdentityContext().role
          )
        ).toBe('run_pipeline.bundle');
        expect(resolveIdentityContext().role).toBe('run_pipeline.bundle');
      },
      'worker'
    );
  });
});

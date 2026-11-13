import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialIdentity } from '@agent/core/foundation/credential-binding';

const mocks = vi.hoisted(() => ({
  identity: vi.fn((): CredentialIdentity => ({})),
  authorize: vi.fn(() => ({ bindingId: 'binding-a', approvalRequired: false })),
  preset: vi.fn(),
  env: vi.fn(() => 'mission-a'),
}));

vi.mock('@agent/core/foundation/credential-binding', () => ({
  credentialExecutionIdentity: mocks.identity,
}));
vi.mock('@agent/core/service/service-binding-registry', () => ({
  authorizeTenantServiceAction: mocks.authorize,
}));
vi.mock('@agent/core/service/service-preset-registry', () => ({
  getServicePresetRecord: mocks.preset,
}));
vi.mock('@agent/core/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/foundation')>()),
  getRegisteredEnvText: mocks.env,
}));

describe('tenant-bound service actuator admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.identity.mockReturnValue({});
    mocks.authorize
      .mockReset()
      .mockReturnValue({ bindingId: 'binding-a', approvalRequired: false });
    mocks.env.mockReturnValue('mission-a');
    mocks.preset.mockReturnValue({
      tenant_binding_required: true,
      operations: { read: { risk: 'read', approval_required: false } },
    });
  });

  it('rejects raw API/CLI modes even when their action name matches a bound preset action', async () => {
    const { authorizeTenantServiceBinding } = await import('./service-actuator-tenant-binding.js');
    for (const mode of ['API', 'CLI', 'SDK', 'MCP']) {
      expect(() =>
        authorizeTenantServiceBinding({ service_id: 'example', mode, action: 'read' })
      ).toThrow(/must execute declared preset operations through PRESET mode/);
    }
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it('admits a declared PRESET operation only after trusted mission scope checks', async () => {
    mocks.identity.mockReturnValue({ tenantSlug: 'acme' });
    const { authorizeTenantServiceBinding } = await import('./service-actuator-tenant-binding.js');
    const result = authorizeTenantServiceBinding({
      service_id: 'example',
      mode: 'PRESET',
      action: 'read',
      context: {
        security_scope: {
          tenant_slug: 'acme',
          mission_id: 'mission-a',
          read_tiers: ['confidential'],
          write_tier: 'confidential',
          purpose: 'test',
        },
      },
    });
    expect(result.bindingId).toBe('binding-a');
    expect(mocks.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 'example', action: 'read' })
    );
  });

  it('allows declared unbound operations in a mixed service only through PRESET', async () => {
    mocks.preset.mockReturnValue({
      operations: {
        read: { tenant_binding_required: true, risk: 'read' },
        status: { tenant_binding_required: false, risk: 'read' },
      },
    });
    const { authorizeTenantServiceBinding } = await import('./service-actuator-tenant-binding.js');
    expect(
      authorizeTenantServiceBinding({
        service_id: 'example',
        mode: 'PRESET',
        action: 'status',
      })
    ).toEqual({ approvalRequired: false });
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
  const scope = {
    tenant_slug: 'acme',
    mission_id: 'mission-a',
    task_id: 'task-a',
    read_tiers: ['confidential'],
    write_tier: 'confidential',
    purpose: 'test',
  };

  it('requires binding for tenant work even when the preset does not opt in', async () => {
    mocks.identity.mockReturnValue({ tenantSlug: 'acme' });
    mocks.preset.mockReturnValue({ operations: { read: { risk: 'read' } } });
    const { authorizeTenantServiceBinding } = await import('./service-actuator-tenant-binding.js');
    const result = authorizeTenantServiceBinding({
      service_id: 'example',
      mode: 'PRESET',
      action: 'read',
      context: { security_scope: scope },
    });
    expect(result.bindingId).toBe('binding-a');
    expect(mocks.authorize).toHaveBeenCalledOnce();
  });

  it.each([
    'No tenant/project service binding',
    'Multiple service bindings match',
    'Service binding denies read',
  ])('does not fall back when binding policy rejects ordinary tenant work: %s', async (reason) => {
    mocks.identity.mockReturnValue({ tenantSlug: 'acme' });
    mocks.preset.mockReturnValue({ operations: { read: { risk: 'read' } } });
    mocks.authorize.mockImplementation(() => {
      throw new Error(reason);
    });
    const { authorizeTenantServiceBinding } = await import('./service-actuator-tenant-binding.js');
    expect(() =>
      authorizeTenantServiceBinding({
        service_id: 'example',
        mode: 'PRESET',
        action: 'read',
        context: { security_scope: scope },
      })
    ).toThrow(reason);
  });

  it('declared tenant scope cannot create authority in an unbound runtime', async () => {
    mocks.preset.mockReturnValue({ operations: { read: { risk: 'read' } } });
    const { authorizeTenantServiceBinding } = await import('./service-actuator-tenant-binding.js');
    expect(() =>
      authorizeTenantServiceBinding({
        service_id: 'example',
        mode: 'PRESET',
        action: 'read',
        context: { security_scope: scope },
      })
    ).toThrow(/does not match execution identity/);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it('runtime tenant cannot omit scope or escape through an opaque execution mode', async () => {
    mocks.preset.mockReturnValue({ operations: { read: { risk: 'read' } } });
    const { authorizeTenantServiceBinding } = await import('./service-actuator-tenant-binding.js');
    mocks.identity.mockReturnValue({ tenantSlug: 'acme' });
    expect(() =>
      authorizeTenantServiceBinding({ service_id: 'example', mode: 'PRESET', action: 'read' })
    ).toThrow(/requires security_scope/);
    for (const mode of ['API', 'CLI', 'SDK', 'MCP']) {
      expect(() =>
        authorizeTenantServiceBinding({
          service_id: 'example',
          mode,
          action: 'read',
          context: { security_scope: scope },
        })
      ).toThrow(/through PRESET mode/);
    }
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it.each([{ tenant_slug: 'other' }, { mission_id: 'other' }, { task_id: 'other' }])(
    'rejects scope contradicting trusted execution: %j',
    async (override) => {
      mocks.preset.mockReturnValue({ operations: { read: { risk: 'read' } } });
      const { authorizeTenantServiceBinding } =
        await import('./service-actuator-tenant-binding.js');
      mocks.identity.mockReturnValue({
        tenantSlug: 'acme',
        missionId: 'mission-a',
        taskId: 'task-a',
      });
      expect(() =>
        authorizeTenantServiceBinding({
          service_id: 'example',
          mode: 'PRESET',
          action: 'read',
          context: { security_scope: { ...scope, ...override } },
        })
      ).toThrow(/does not match execution identity/);
      expect(mocks.authorize).not.toHaveBeenCalled();
    }
  );

  it('preserves non-tenant execution and non-execution administration of ordinary presets', async () => {
    mocks.preset.mockReturnValue({ operations: { read: { risk: 'read' } } });
    const { authorizeTenantServiceBinding } = await import('./service-actuator-tenant-binding.js');
    expect(
      authorizeTenantServiceBinding({ service_id: 'example', mode: 'PRESET', action: 'read' })
    ).toEqual({ approvalRequired: false });
    mocks.identity.mockReturnValue({ tenantSlug: 'acme' });
    for (const mode of ['HARNESS', 'OAUTH', 'RECONCILE']) {
      expect(
        authorizeTenantServiceBinding({ service_id: 'example', mode, action: 'read' })
      ).toEqual({ approvalRequired: false });
    }
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
});

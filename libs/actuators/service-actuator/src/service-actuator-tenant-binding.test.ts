import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(() => ({ bindingId: 'binding-a', approvalRequired: false })),
  preset: vi.fn(),
  env: vi.fn(() => 'mission-a'),
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
});

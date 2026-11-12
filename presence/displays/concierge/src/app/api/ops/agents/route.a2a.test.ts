import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const f = vi.hoisted(() => ({
  viewer: {
    role: 'localadmin',
    tenantSlugs: 'all' as string[] | 'all',
    source: 'loopback',
  },
  accessDenied: null as unknown,
  route: vi.fn(),
}));

vi.mock('../../../../lib/ops/ops-request-guard', () => ({
  guardOpsRequest: vi.fn((): unknown => null),
  getOpsAccessRole: vi.fn(() => 'localadmin'),
  requireOpsAccess: vi.fn((): unknown => f.accessDenied),
  roleToMissionRole: vi.fn(() => 'mission_controller'),
}));

vi.mock('../../../../lib/ops/ops-viewer', () => ({
  resolveOpsViewerForRequest: vi.fn(() => ({ context: f.viewer })),
  withViewerExecutionContextAsync: vi.fn(async (_viewer: unknown, run: () => unknown) => run()),
  viewerErrorResponse: vi.fn((error: unknown, status = 500) =>
    Response.json({ error: error instanceof Error ? error.message : String(error) }, { status })
  ),
}));

vi.mock('@agent/core/mesh/a2a-bridge', () => ({ a2aBridge: { route: f.route } }));

import { POST } from './route';

function post(envelope: unknown): Promise<Response> {
  return POST({ json: async () => ({ action: 'a2a', envelope }) } as unknown as NextRequest);
}

function envelope(securityScope?: Record<string, unknown>) {
  return {
    a2a_version: '1.0',
    header: { msg_id: 'msg-1', sender: 'kyberion:concierge', performative: 'request' },
    payload: {
      text: 'hello',
      ...(securityScope ? { context: { security_scope: securityScope } } : {}),
    },
  };
}

const scopeFor = (tenant: Record<string, unknown>) => ({
  mission_id: 'MSN-1',
  read_tiers: ['public'],
  write_tier: 'confidential',
  purpose: 'test',
  ...tenant,
});

beforeEach(() => {
  f.viewer = { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' };
  f.accessDenied = null;
  f.route.mockReset();
  f.route.mockResolvedValue({ a2a_version: '1.0', header: {}, payload: { text: 'ok' } });
});

describe('agents route a2a action', () => {
  it('routes a schema-valid envelope for an all-tenant localadmin', async () => {
    const response = await post(envelope(scopeFor({ tenant_slug: 'tenant-b' })));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
    expect(f.route).toHaveBeenCalledTimes(1);
    expect(f.route.mock.calls[0][0]).toMatchObject({ header: { msg_id: 'msg-1' } });
  });

  it.each([
    [
      'missing a2a_version',
      { header: { msg_id: 'm', sender: 's', performative: 'request' }, payload: {} },
    ],
    [
      'missing payload',
      { a2a_version: '1.0', header: { msg_id: 'm', sender: 's', performative: 'request' } },
    ],
    [
      'missing sender',
      { a2a_version: '1.0', header: { msg_id: 'm', performative: 'request' }, payload: {} },
    ],
    [
      'unknown performative',
      {
        a2a_version: '1.0',
        header: { msg_id: 'm', sender: 's', performative: 'command' },
        payload: {},
      },
    ],
    [
      'non-object payload',
      {
        a2a_version: '1.0',
        header: { msg_id: 'm', sender: 's', performative: 'request' },
        payload: 'text',
      },
    ],
  ])('refuses an envelope with %s before the bridge (400)', async (_label, invalid) => {
    const response = await post(invalid);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid A2A envelope' });
    expect(f.route).not.toHaveBeenCalled();
  });

  it('routes for a tenant-scoped localadmin when the security scope names its own tenant', async () => {
    f.viewer = { role: 'localadmin', tenantSlugs: ['tenant-a'], source: 'loopback' };
    const response = await post(envelope(scopeFor({ tenant_slug: 'tenant-a' })));
    expect(response.status).toBe(200);
    expect(f.route).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['tenant_slug', { tenant_slug: 'tenant-b' }],
    ['the tenant_id alias', { tenant_id: 'tenant-b' }],
    ['a conflicting alias', { tenant_slug: 'tenant-a', tenant_id: 'tenant-b' }],
    ['a malformed tenant claim', { tenant_slug: ['tenant-a'] }],
    ['a security scope without a tenant', {}],
  ])('refuses a tenant-scoped localadmin when %s is outside its set (403)', async (_label, t) => {
    f.viewer = { role: 'localadmin', tenantSlugs: ['tenant-a'], source: 'loopback' };
    const response = await post(envelope(scopeFor(t)));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error:
        'A tenant-scoped viewer may route only an A2A envelope whose security scope names a tenant inside the viewer scope.',
    });
    expect(f.route).not.toHaveBeenCalled();
  });

  it.each([
    ['no security scope', envelope()],
    [
      'a non-object security scope',
      { ...envelope(), payload: { context: { security_scope: 'x' } } },
    ],
    [
      'a mission_id but no security scope',
      { ...envelope(), payload: { context: { mission_id: 'MSN-1' } } },
    ],
  ])('refuses a tenant-scoped localadmin whose envelope has %s (403)', async (_label, unscoped) => {
    f.viewer = { role: 'localadmin', tenantSlugs: ['tenant-a'], source: 'loopback' };
    const response = await post(unscoped);
    expect(response.status).toBe(403);
    expect(f.route).not.toHaveBeenCalled();
  });

  it('routes for a tenant-scoped localadmin naming its own tenant through both aliases', async () => {
    f.viewer = { role: 'localadmin', tenantSlugs: ['tenant-a'], source: 'loopback' };
    const response = await post(
      envelope(scopeFor({ tenant_slug: 'tenant-a', tenant_id: 'tenant-a' }))
    );
    expect(response.status).toBe(200);
    expect(f.route).toHaveBeenCalledTimes(1);
  });

  it('refuses a tenant-scoped localadmin whose context names another mission than its scope (403)', async () => {
    f.viewer = { role: 'localadmin', tenantSlugs: ['tenant-a'], source: 'loopback' };
    const scope = scopeFor({ tenant_slug: 'tenant-a' });
    const mismatch = {
      ...envelope(),
      payload: { context: { security_scope: scope, mission_id: 'MSN-2' } },
    };
    expect((await post(mismatch)).status).toBe(403);
    expect(f.route).not.toHaveBeenCalled();

    const matching = {
      ...envelope(),
      payload: { context: { security_scope: scope, mission_id: 'MSN-1' } },
    };
    expect((await post(matching)).status).toBe(200);
    expect(f.route).toHaveBeenCalledTimes(1);

    // An all-tenant localadmin is not restricted by this rule.
    f.viewer = { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' };
    expect((await post(mismatch)).status).toBe(200);
  });

  it('still routes an unscoped envelope for an all-tenant localadmin', async () => {
    const response = await post(envelope());
    expect(response.status).toBe(200);
    expect(f.route).toHaveBeenCalledTimes(1);
  });

  it('keeps refusing viewers below localadmin', async () => {
    f.accessDenied = Response.json({ error: 'forbidden' }, { status: 403 });
    const response = await post(envelope());
    expect(response.status).toBe(403);
    expect(f.route).not.toHaveBeenCalled();
  });
});

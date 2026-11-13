// `/api/me` is the read a page uses to learn which tenant it is viewing and to
// replace a stale stored one. It therefore answers a hint that names no
// registered tenant with the default view instead of a refusal — and never
// reports the unregistered slug as the viewed tenant.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type express from 'express';

vi.mock('./conversation-routes.js', () => ({ registerConversationRoutes: () => {} }));
vi.mock('./presence-studio-runtime-data.js', () => ({
  resolveSafeExistingFile: (): null => null,
  presenceStudioWireError: (error: unknown, status: number) => ({
    ok: false,
    status,
    error: error instanceof Error ? error.message : String(error),
  }),
}));
vi.mock('@agent/core/authority', () => ({
  withStoreGrant: (_name: string, fn: () => unknown) => fn(),
  withStoreGrantAsync: async (_name: string, fn: () => unknown) => fn(),
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/organization/member-registry', () => ({
  resolveMemberByPrincipal: (): null => null,
  memberBindingDenied: () => false,
}));
const REGISTERED = ['alpha-team', 'beta-team'];
vi.mock('@agent/core/organization/tenant-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/organization/tenant-registry')>()),
  listTenantProfileSlugs: () => REGISTERED,
  readTenantProfile: (slug: string) =>
    REGISTERED.includes(slug)
      ? { tenant_slug: slug, display_name: slug, status: 'active', assigned_role: 'owner' }
      : null,
}));

import { registerFrontDeskRoutes } from './front-desk-routes.js';

const handlers = new Map<string, express.RequestHandler>();
registerFrontDeskRoutes({
  get: (p: string, h: express.RequestHandler) => handlers.set('GET ' + p, h),
  post: (p: string, h: express.RequestHandler) => handlers.set('POST ' + p, h),
} as unknown as express.Express);

function get(route: string, query: Record<string, string>) {
  const req = {
    query,
    params: {},
    headers: { host: '127.0.0.1:3031' },
    socket: { remoteAddress: '127.0.0.1' },
    path: route,
    method: 'GET',
  } as unknown as express.Request;
  const res = {
    statusCode: 200,
    body: {} as { ok?: boolean; viewing?: { tenant_slug: string } | null; error?: string },
    setHeader() {
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: typeof res.body) {
      this.body = body;
      return this;
    },
  };
  handlers.get('GET ' + route)!(req, res as unknown as express.Response, () => undefined);
  return res;
}

afterEach(() => vi.unstubAllEnvs());

describe('GET /api/me with a tenant hint', () => {
  it('answers an unregistered hint with the default view, never the unregistered slug', () => {
    vi.stubEnv('KYBERION_TENANT', 'beta-team');
    const res = get('/api/me', { tenant: 'tenant-ghost' });
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.viewing?.tenant_slug).toBe('beta-team');
    expect(JSON.stringify(res.body)).not.toContain('tenant-ghost');
  });

  it('views a registered tenant the page asks for', () => {
    vi.stubEnv('KYBERION_TENANT', 'beta-team');
    const res = get('/api/me', { tenant: 'alpha-team' });
    expect(res.statusCode).toBe(200);
    expect(res.body.viewing?.tenant_slug).toBe('alpha-team');
  });

  it('is the only read that tolerates the unregistered hint: the nav route refuses it', () => {
    vi.stubEnv('KYBERION_TENANT', 'beta-team');
    const res = get('/api/front-desk/nav', { tenant: 'tenant-ghost' });
    expect(res.statusCode).toBe(403);
  });
});

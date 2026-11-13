import { beforeEach, describe, expect, it, vi } from 'vitest';
import type express from 'express';
import type { PresenceStudioViewerContext } from './security.js';

const f = vi.hoisted(() => ({
  viewer: null as unknown,
  viewerError: null as Error | null,
  approvals: [] as Record<string, unknown>[],
}));
vi.mock('./security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./security.js')>()),
  resolvePresenceStudioViewerContext: () => {
    if (f.viewerError) throw f.viewerError;
    return f.viewer;
  },
}));
vi.mock('@agent/core/governance/approval-store', () => ({
  listApprovalRequests: () => f.approvals,
  decideApprovalRequest: vi.fn(),
  surfaceDecisionAuthMethod: vi.fn(),
  surfaceDecisionBinding: vi.fn(),
}));
vi.mock('./surface-auth.js', () => ({ presenceStudioAuthRateLimiter: vi.fn() }));
vi.mock('./presence-studio-runtime-data.js', () => ({
  buildApprovalInboxItem: (record: { id: string }) => ({ id: record.id }),
  presenceStudioWireError: (error: unknown, status: number) => ({
    ok: false,
    status,
    error: error instanceof Error ? error.message : String(error),
  }),
  cloudflareOsSurface: { snapshot: () => ({ heldActions: [] }) },
}));

import { registerApprovalInboxRoutes } from './approval-inbox-routes.js';
import { PresenceStudioViewerError } from './security.js';

type Handler = (req: express.Request, res: express.Response) => void;

function listApprovals(): { status: number; body: { ok: boolean; items?: { id: string }[] } } {
  const handlers = new Map<string, Handler>();
  const app = {
    get: (path: string, handler: Handler) => handlers.set(`GET ${path}`, handler),
    post: () => undefined,
  } as unknown as express.Express;
  registerApprovalInboxRoutes(app, () => null);
  const out = { status: 200, body: { ok: false } as { ok: boolean; items?: { id: string }[] } };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: typeof out.body) {
      out.body = body;
      return res;
    },
  } as unknown as express.Response;
  handlers.get('GET /api/approvals')!({ query: {}, headers: {} } as express.Request, res);
  return out;
}

const loopback: PresenceStudioViewerContext = {
  principalId: 'human:presence-studio-localadmin',
  source: 'loopback',
  tenantSlugs: 'all',
};
const scope = (tenant: string) => ({ tier: 'confidential', tenant_slug: tenant });

beforeEach(() => {
  f.viewer = loopback;
  f.viewerError = null;
  f.approvals = [
    { id: 'alpha-1', scope: scope('alpha-team') },
    { id: 'beta-1', scope: scope('beta-team') },
    { id: 'unscoped-1' },
  ];
});

describe('GET /api/approvals viewer scope', () => {
  it('lists every pending request for the all-tenant loopback owner (unchanged)', () => {
    const result = listApprovals();
    expect(result.status).toBe(200);
    expect(result.body.items?.map((item) => item.id)).toEqual(['alpha-1', 'beta-1', 'unscoped-1']);
  });

  it('lists the viewed tenant and tenant-less requests for a loopback owner narrowed to one tenant', () => {
    f.viewer = { ...loopback, tenantSlugs: ['alpha-team'] };
    // Its tenant's requests plus the tenant-less ones; never another tenant's.
    expect(listApprovals().body.items?.map((item) => item.id)).toEqual(['alpha-1', 'unscoped-1']);
  });

  it('never lists another tenant or an unclassified request to a remote token viewer', () => {
    f.viewer = {
      principalId: 'human:presence-studio-token',
      source: 'token',
      tenantSlugs: ['alpha-team'],
    };
    expect(listApprovals().body.items?.map((item) => item.id)).toEqual(['alpha-1']);
  });

  it('answers with the viewer error status when no viewer can be resolved', () => {
    f.viewerError = new PresenceStudioViewerError(403, 'viewer scope denied');
    const result = listApprovals();
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ ok: false, error: 'viewer scope denied' });
  });
});

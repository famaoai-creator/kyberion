import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const lib = vi.hoisted(() => ({
  readCharterOverview: vi.fn(),
  previewCharter: vi.fn(),
  acceptCharterForViewer: vi.fn(),
  actOnCharter: vi.fn(),
}));

vi.mock('../../../lib/api-guard', () => ({ requireConciergeMutationAccess: vi.fn(() => null) }));
vi.mock('../../../lib/viewer-context', () => ({
  resolveConciergeViewer: vi.fn(() => ({
    context: { tenantSlugs: ['acme'], source: 'token', memberId: 'owner' },
  })),
  conciergeErrorResponse: vi.fn((e: unknown) => new Response(String(e), { status: 500 }) as never),
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: vi.fn((_r: string, fn: () => unknown) => fn()),
}));
vi.mock('@agent/core/secure-io', () => ({
  withSensitivePathMediation: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../../../lib/charter-server', () => lib);

import { GET, POST } from './route.js';
import { POST as TRIPWIRE } from './tripwire/route.js';

const post = (body: unknown) =>
  ({
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  }) as unknown as NextRequest;
const get = (query = '') =>
  ({
    headers: new Headers(),
    nextUrl: new URL(`http://x/api/charters${query}`),
  }) as unknown as NextRequest;

describe('/api/charters', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET returns the overview for the resolved viewer and passes ?tenant= only as a narrowing hint', async () => {
    lib.readCharterOverview.mockReturnValue({ tenants: [], member: null });
    const res = await GET(get('?tenant=acme'));
    expect(res.status).toBe(200);
    expect(lib.readCharterOverview.mock.calls[0][0]).toMatchObject({ tenantSlugs: ['acme'] });
    expect(lib.readCharterOverview.mock.calls[0][1]).toBe('acme');
    expect((await res.json()).ok).toBe(true);
  });

  it('POST needs a known action and never takes the accountable human from the body', async () => {
    expect((await POST(post({ action: 'delete' }))).status).toBe(400);
    // `accountable` / `member` are not accepted keys (known-keys contract).
    expect(
      (await POST(post({ action: 'preview', form: {}, accountable: 'user:mallory' }))).status
    ).toBe(400);
    expect(lib.previewCharter).not.toHaveBeenCalled();
  });

  it('POST preview / accept delegate to the server logic and surface its status codes', async () => {
    lib.previewCharter.mockReturnValue({
      ok: true,
      statement: 's',
      statement_sha256: 'a'.repeat(64),
      replaces: null,
    });
    const ok = await POST(post({ action: 'preview', form: { tenant_slug: 'acme' } }));
    expect(ok.status).toBe(200);
    lib.acceptCharterForViewer.mockReturnValue({
      ok: false,
      status: 409,
      error: 'statement_changed',
    });
    const conflict = await POST(post({ action: 'accept', form: {}, statement_sha256: 'x' }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ ok: false, error: 'statement_changed' });
    expect(lib.acceptCharterForViewer.mock.calls[0][2]).toBe('x');
  });

  it('tripwire route: only stop|clear|retire; server decides who may', async () => {
    expect((await TRIPWIRE(post({ tenant_slug: 'acme', action: 'explode' }))).status).toBe(400);
    lib.actOnCharter.mockReturnValue({ ok: false, status: 403, error: 'not_responsible' });
    const denied = await TRIPWIRE(post({ tenant_slug: 'acme', action: 'stop' }));
    expect(denied.status).toBe(403);
    lib.actOnCharter.mockReturnValue({ ok: true, action: 'stop' });
    expect((await TRIPWIRE(post({ tenant_slug: 'acme', action: 'stop' }))).status).toBe(200);
    expect(lib.actOnCharter.mock.calls[1].slice(1, 3)).toEqual(['acme', 'stop']);
  });
});

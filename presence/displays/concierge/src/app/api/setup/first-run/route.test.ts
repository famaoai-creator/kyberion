import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  open: vi.fn(),
}));

vi.mock('../../../../lib/first-run-server', () => ({
  claimFirstRunForRequest: mocks.claim,
  firstRunOpen: mocks.open,
}));

import { GET, POST } from './route';

function post(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://desk.example.com/api/setup/first-run', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      host: 'desk.example.com',
      origin: 'http://desk.example.com',
      ...headers,
    },
  });
}

const body = { code: 'ABCD', tenant_slug: 'acme', display_name: 'Hana' };

describe('/api/setup/first-run', () => {
  beforeEach(() => {
    mocks.claim.mockReset();
    mocks.open.mockReset();
  });

  it('GET exposes only the open/closed state', async () => {
    mocks.open.mockReturnValue(true);
    const res = await GET(new NextRequest('http://desk.example.com/api/setup/first-run'));
    expect(await res.json()).toEqual({ ok: true, state: 'unclaimed' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects a cross-origin claim before touching the code', async () => {
    const res = await POST(post(body, { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('rejects unknown keys', async () => {
    const res = await POST(post({ ...body, role: 'owner' }));
    expect(res.status).toBe(400);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('maps a claim failure to its status and code', async () => {
    mocks.claim.mockReturnValue({ ok: false, status: 403, error: 'code_invalid' });
    const res = await POST(post(body));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'code_invalid' });
  });

  it('returns the one-time token without caching', async () => {
    mocks.claim.mockReturnValue({
      ok: true,
      token: 'raw',
      member_id: 'owner',
      tenant_slug: 'acme',
      tenant_slugs: ['acme'],
    });
    const res = await POST(post(body));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ ok: true, token: 'raw' });
    expect(mocks.claim).toHaveBeenCalledWith(body);
  });

  it('caps claim attempts per client', async () => {
    mocks.claim.mockReturnValue({ ok: false, status: 403, error: 'code_invalid' });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await POST(post(body))).status);
    expect(statuses).toContain(429);
  });
});

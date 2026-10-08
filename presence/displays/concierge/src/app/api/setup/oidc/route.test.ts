import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  isOwner: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
}));

vi.mock('../../../../lib/api-guard', () => ({
  requireConciergeMutationAccess: vi.fn(() => null),
}));
vi.mock('../../../../lib/viewer-context', () => ({
  resolveConciergeViewer: vi.fn(() => ({
    context: { role: 'localadmin', tenantSlugs: ['acme'], source: 'token', principalId: 'p' },
  })),
}));
vi.mock('../../../../lib/first-run-server', () => ({
  viewerIsInstanceOwner: mocks.isOwner,
  readSsoSettings: mocks.read,
  saveSsoSettings: mocks.save,
}));

import { GET, PUT } from './route';

function request(body?: unknown): NextRequest {
  return {
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as NextRequest;
}

describe('/api/setup/oidc', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it('is limited to instance owners', async () => {
    mocks.isOwner.mockReturnValue(false);
    expect((await GET(request())).status).toBe(403);
    expect((await PUT(request({ issuer: 'https://idp.example', client_id: 'a' }))).status).toBe(
      403
    );
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('reads the summary for an instance owner', async () => {
    mocks.isOwner.mockReturnValue(true);
    mocks.read.mockReturnValue({ settings: { source: 'none' }, redirect_uris: ['u'] });
    const res = await GET(request());
    expect(await res.json()).toEqual({
      ok: true,
      settings: { source: 'none' },
      redirect_uris: ['u'],
    });
  });

  it('saves with the resolved viewer and surfaces field errors', async () => {
    mocks.isOwner.mockReturnValue(true);
    mocks.save.mockReturnValueOnce({
      ok: false,
      status: 400,
      error: 'invalid_input',
      field: 'issuer',
    });
    const bad = await PUT(request({ issuer: 'http://idp.example', client_id: 'a' }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: 'invalid_input', field: 'issuer' });
    expect(mocks.save.mock.calls[0]![0]).toMatchObject({ principalId: 'p' });

    const unknown = await PUT(request({ issuer: 'https://idp.example', client_id: 'a', extra: 1 }));
    expect(unknown.status).toBe(400);
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
});

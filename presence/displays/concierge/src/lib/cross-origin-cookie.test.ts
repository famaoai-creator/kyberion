import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ conciergeCredential: vi.fn() }));
vi.mock('./viewer-context', () => ({ conciergeCredential: mocks.conciergeCredential }));

import { crossOriginCookieMutation } from './cross-origin-cookie';

function request(method: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://127.0.0.1:3050/api/ops/workitems', {
    method,
    headers: { host: '127.0.0.1:3050', ...headers },
  });
}

describe('cross-origin check for cookie-borne requests', () => {
  beforeEach(() => {
    mocks.conciergeCredential.mockReturnValue({ token: 'kys1.x.y', source: 'session-cookie' });
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'lets a cookie-borne %s through from any origin',
    (method) => {
      expect(
        crossOriginCookieMutation(
          request(method, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })
        )
      ).toBeNull();
    }
  );

  it('blocks a cookie-borne POST that names no origin at all', async () => {
    const blocked = crossOriginCookieMutation(request('POST'));
    expect(blocked?.status).toBe(403);
    expect(await blocked?.json()).toEqual({
      ok: false,
      error: 'Forbidden. Cross-origin session request.',
    });
  });

  it('blocks a cross-site cookie-borne POST', () => {
    expect(
      crossOriginCookieMutation(
        request('POST', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })
      )?.status
    ).toBe(403);
    // A matching Origin does not rescue a request the browser marked cross-site.
    expect(
      crossOriginCookieMutation(
        request('POST', { origin: 'http://127.0.0.1:3050', 'sec-fetch-site': 'cross-site' })
      )?.status
    ).toBe(403);
    expect(
      crossOriginCookieMutation(request('POST', { origin: 'https://evil.example' }))?.status
    ).toBe(403);
  });

  it('lets a same-origin cookie-borne POST through', () => {
    expect(
      crossOriginCookieMutation(request('POST', { origin: 'http://127.0.0.1:3050' }))
    ).toBeNull();
    expect(
      crossOriginCookieMutation(request('POST', { referer: 'http://127.0.0.1:3050/ops' }))
    ).toBeNull();
    expect(
      crossOriginCookieMutation(request('POST', { 'sec-fetch-site': 'same-origin' }))
    ).toBeNull();
  });

  it('does not apply to a header (token) credential or to no credential', () => {
    const crossSite = request('POST', {
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    });
    mocks.conciergeCredential.mockReturnValue({ token: 'opaque', source: 'header' });
    expect(crossOriginCookieMutation(crossSite)).toBeNull();
    mocks.conciergeCredential.mockReturnValue({ token: null, source: 'none' });
    expect(crossOriginCookieMutation(crossSite)).toBeNull();
    // A credential the caller already extracted is used as given.
    expect(crossOriginCookieMutation(crossSite, { source: 'session-cookie' })?.status).toBe(403);
  });
});

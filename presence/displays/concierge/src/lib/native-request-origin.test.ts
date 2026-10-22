import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeSurfaceMutation,
  surfaceMutationRequestUrl,
} from '@agent/core/surface/surface-mutation-guard';

beforeEach(() => {
  vi.stubEnv('KYBERION_API_TOKEN', '');
  vi.stubEnv('KYBERION_LOCALADMIN_TOKEN', '');
});
afterEach(() => vi.unstubAllEnvs());
const decision = (request: NextRequest) =>
  authorizeSurfaceMutation({
    url: surfaceMutationRequestUrl(request),
    getHeader: (name) => request.headers.get(name),
  });

describe('native NextRequest origin boundary', () => {
  it.each(['127.0.0.1', '[::1]'])('preserves the server-bound %s origin', (host) => {
    const origin = 'http://' + host + ':3050';
    const request = new NextRequest(origin + '/api/management/participants', {
      method: 'POST',
      headers: { origin },
    });
    expect(surfaceMutationRequestUrl(request)).toBe(origin + '/api/management/participants');
    expect(decision(request)).toMatchObject({ ok: true, reason: 'same-origin' });
  });
  const deniedOrigins: Array<[string, Record<string, string>]> = [
    ['http://127.0.0.1:3051', {}],
    ['http://localhost:3050', {}],
    ['https://127.0.0.1:3050', {}],
    ['https://evil.example', {}],
    [
      'https://evil.example',
      { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
    ],
  ];
  it.each(deniedOrigins)(
    'denies a different origin %s regardless of supplied host metadata',
    (origin, extra) => {
      const request = new NextRequest('http://127.0.0.1:3050/api/management/participants', {
        method: 'POST',
        headers: { origin, ...extra },
      });
      expect(decision(request)).toMatchObject({ ok: false, status: 403 });
    }
  );
  it('does not turn an absent Origin into same-origin authority', () => {
    const request = new NextRequest('http://127.0.0.1:3050/api/x', {
      method: 'POST',
      headers: { host: '127.0.0.1:3050' },
    });
    expect(decision(request).ok).toBe(false);
  });
  it('retains the explicit URL of a framework-neutral adapter', () => {
    expect(surfaceMutationRequestUrl({ url: 'https://app.example/api/x' })).toBe(
      'https://app.example/api/x'
    );
  });
});

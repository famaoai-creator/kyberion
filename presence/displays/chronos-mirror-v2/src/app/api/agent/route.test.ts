import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/api-guard', () => ({
  guardRequest: vi.fn(() => null),
}));

vi.mock('../../../lib/viewer-context', () => ({
  resolveViewerContextForRequest: vi.fn(() => ({
    context: { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' },
  })),
}));

import { POST } from './route.js';

describe('chronos agent route', () => {
  it('returns a user-facing envelope when request parsing fails', async () => {
    const request = {
      headers: new Headers({
        'content-type': 'application/json',
        authorization: 'Bearer local-test-token',
        'x-forwarded-for': '127.0.0.1',
      }),
      cookies: {
        get: () => undefined,
      },
      ip: '127.0.0.1',
      json: async () => JSON.parse('{'),
    } as any;

    process.env.KYBERION_API_TOKEN = 'local-test-token';
    const response = await POST(request);
    delete process.env.KYBERION_API_TOKEN;

    expect(response.status).toBe(500);
    const payload = (await response.json()) as {
      title: string;
      error: string;
      nextAction: string;
    };
    expect(payload.title).toBeTruthy();
    expect(payload.error).toBeTruthy();
    expect(payload.error).not.toContain('Unexpected token');
    expect(payload.nextAction).toBeTruthy();
  });
});

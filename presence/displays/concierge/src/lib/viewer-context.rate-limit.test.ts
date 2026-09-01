import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { checkConciergeRateLimit } from './viewer-context';

describe('Concierge request rate limit', () => {
  it('separates token and HTTP method buckets and returns retry metadata', () => {
    const token = `rate-limit-test-${Date.now()}-${Math.random()}`;
    const getRequest = new NextRequest('http://localhost/api/concierge/home', {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    const postRequest = new NextRequest('http://localhost/api/concierge/home', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(checkConciergeRateLimit(getRequest, { limit: 1 })).toEqual({ ok: true });
    expect(checkConciergeRateLimit(getRequest, { limit: 1 })).toMatchObject({
      ok: false,
      retryAfterSeconds: expect.any(Number),
    });
    expect(checkConciergeRateLimit(postRequest, { limit: 1 })).toEqual({ ok: true });
  });
});

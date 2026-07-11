import { afterEach, describe, expect, it } from 'vitest';
import { authorizeSurfaceMutation } from './surface-mutation-guard.js';

function makeRequest(url: string, headers: Record<string, string> = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return { url, getHeader: (name: string) => normalized[name.toLowerCase()] ?? null };
}

const originalApiToken = process.env.KYBERION_API_TOKEN;
const originalAdminToken = process.env.KYBERION_LOCALADMIN_TOKEN;

afterEach(() => {
  if (originalApiToken === undefined) delete process.env.KYBERION_API_TOKEN;
  else process.env.KYBERION_API_TOKEN = originalApiToken;
  if (originalAdminToken === undefined) delete process.env.KYBERION_LOCALADMIN_TOKEN;
  else process.env.KYBERION_LOCALADMIN_TOKEN = originalAdminToken;
});

describe('surface-mutation-guard', () => {
  it('does not trust a loopback request URL without request authentication', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const decision = authorizeSurfaceMutation(makeRequest(`http://${host}:3050/api/x`));
      expect(decision.ok, host).toBe(false);
      expect(decision.status).toBe(403);
    }
  });

  it('rejects a spoofed loopback host without a token or same-origin proof', () => {
    const decision = authorizeSurfaceMutation(
      makeRequest('http://localhost:3050/api/approvals/approval-1', {
        host: 'localhost:3050',
        origin: 'https://evil.example.com',
      })
    );
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe(403);
  });

  it('allows a valid bearer token on non-loopback hosts', () => {
    process.env.KYBERION_API_TOKEN = 'secret-token';
    const decision = authorizeSurfaceMutation(
      makeRequest('https://kyberion.example.com/api/x', {
        authorization: 'Bearer secret-token',
      })
    );
    expect(decision.ok).toBe(true);
    expect(decision.reason).toBe('token');
  });

  it('rejects an invalid bearer token without same-origin', () => {
    process.env.KYBERION_API_TOKEN = 'secret-token';
    const decision = authorizeSurfaceMutation(
      makeRequest('https://kyberion.example.com/api/x', { authorization: 'Bearer wrong' })
    );
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe(403);
  });

  it('does not treat an unset configured token as a valid bearer token', () => {
    delete process.env.KYBERION_API_TOKEN;
    delete process.env.KYBERION_LOCALADMIN_TOKEN;
    const decision = authorizeSurfaceMutation(
      makeRequest('https://kyberion.example.com/api/x', { authorization: 'Bearer undefined' })
    );
    expect(decision.ok).toBe(false);
  });

  it('allows same-origin requests', () => {
    const decision = authorizeSurfaceMutation(
      makeRequest('https://kyberion.example.com/api/x', {
        origin: 'https://kyberion.example.com',
      })
    );
    expect(decision.ok).toBe(true);
    expect(decision.reason).toBe('same-origin');
  });

  it('denies cross-origin requests without a token', () => {
    const decision = authorizeSurfaceMutation(
      makeRequest('https://kyberion.example.com/api/x', { origin: 'https://evil.example.com' })
    );
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe(403);
  });
});

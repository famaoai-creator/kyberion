import { describe, expect, it } from 'vitest';
import { authorizeOperatorSurfaceMutation } from './api-guard.js';

function makeRequest(url: string, headers: Record<string, string> = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    url,
    headers: {
      get(name: string) {
        return normalized[name.toLowerCase()] || null;
      },
    },
  } as any;
}

describe('operator-surface api guard', () => {
  it('allows loopback hosts without a token', () => {
    const decision = authorizeOperatorSurfaceMutation(makeRequest('http://localhost/api/inbox'));
    expect(decision.ok).toBe(true);
  });

  it('allows same-origin mutations', () => {
    const decision = authorizeOperatorSurfaceMutation(
      makeRequest('https://example.com/api/inbox', {
        origin: 'https://example.com',
      })
    );
    expect(decision.ok).toBe(true);
  });

  it('rejects cross-origin mutations without a token', () => {
    const decision = authorizeOperatorSurfaceMutation(
      makeRequest('https://example.com/api/inbox', {
        origin: 'https://evil.example',
      })
    );
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe(403);
  });

  it('rejects requests with no origin and no token', () => {
    const decision = authorizeOperatorSurfaceMutation(makeRequest('https://example.com/api/inbox'));
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe(403);
  });
});

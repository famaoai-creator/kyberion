import { describe, expect, it } from 'vitest';
import {
  buildLoginRedirectPath,
  extractSurfaceCredential,
  extractSurfaceSessionToken,
  isHtmlNavigationRequest,
  isSameOriginMutation,
  parseCookieHeader,
  peekSessionExpiry,
  resolveLoginRedirect,
  sanitizeNextPath,
  serializeCookie,
} from './surface-session-cookie.js';

const nav = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
const fetchApi = { 'sec-fetch-mode': 'cors', accept: 'application/json' };

describe('sanitizeNextPath', () => {
  it.each([
    ['/settings?tab=a', '/settings?tab=a'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['/ok\r\nSet-Cookie: x=1', '/'],
    ['/login?next=/', '/'],
    ['/auth/callback', '/'],
    [undefined, '/'],
    [null, '/'],
  ])('%s -> %s', (input, expected) => {
    expect(sanitizeNextPath(input as string | null | undefined)).toBe(expected);
  });

  it('builds a login path that round-trips the next target', () => {
    expect(buildLoginRedirectPath('/work?x=1')).toBe('/login?next=%2Fwork%3Fx%3D1');
    expect(buildLoginRedirectPath('/')).toBe('/login');
  });
});

describe('cookies', () => {
  it('parses a Cookie header and extracts only a kys1. session', () => {
    expect(parseCookieHeader('a=1; kyberion_session=kys1.x.y; b="q"')).toMatchObject({
      a: '1',
      b: 'q',
    });
    expect(extractSurfaceSessionToken('kyberion_session=kys1.x.y')).toBe('kys1.x.y');
    expect(extractSurfaceSessionToken('kyberion_session=notasession')).toBe('');
    expect(extractSurfaceSessionToken(undefined)).toBe('');
  });

  it('serializes HttpOnly + SameSite and Secure only on request', () => {
    const plain = serializeCookie('n', 'v', { maxAgeSeconds: 60 });
    expect(plain).toContain('HttpOnly');
    expect(plain).toContain('SameSite=Lax');
    expect(plain).not.toContain('Secure');
    expect(serializeCookie('n', 'v', { secure: true })).toContain('Secure');
  });
});

describe('resolveLoginRedirect', () => {
  const base = { method: 'GET', headers: nav, loopback: false, hasCredential: false };

  it('sends an unauthenticated remote page navigation to /login with next', () => {
    expect(resolveLoginRedirect({ ...base, pathname: '/settings', search: '?a=1' })).toBe(
      '/login?next=%2Fsettings%3Fa%3D1'
    );
    expect(resolveLoginRedirect({ ...base, pathname: '/' })).toBe('/login');
  });

  it('never redirects loopback, credentialed requests, APIs, assets or auth routes', () => {
    expect(resolveLoginRedirect({ ...base, pathname: '/', loopback: true })).toBeNull();
    expect(resolveLoginRedirect({ ...base, pathname: '/', hasCredential: true })).toBeNull();
    expect(resolveLoginRedirect({ ...base, pathname: '/api/me' })).toBeNull();
    expect(resolveLoginRedirect({ ...base, pathname: '/a2ui/dispatch' })).toBeNull();
    expect(resolveLoginRedirect({ ...base, pathname: '/_next/static/x.js' })).toBeNull();
    expect(resolveLoginRedirect({ ...base, pathname: '/login' })).toBeNull();
    expect(resolveLoginRedirect({ ...base, pathname: '/auth/callback' })).toBeNull();
  });

  it('keeps API semantics for fetch/XHR and non-GET methods', () => {
    expect(resolveLoginRedirect({ ...base, pathname: '/x', headers: fetchApi })).toBeNull();
    expect(resolveLoginRedirect({ ...base, pathname: '/x', method: 'POST' })).toBeNull();
  });

  it('falls back to Accept when Sec-Fetch-* is absent', () => {
    expect(
      isHtmlNavigationRequest({
        method: 'GET',
        headers: { accept: 'text/html,application/xhtml+xml' },
      })
    ).toBe(true);
    expect(
      isHtmlNavigationRequest({ method: 'GET', headers: { accept: 'application/json' } })
    ).toBe(false);
    expect(isHtmlNavigationRequest({ method: 'GET', headers: {} })).toBe(false);
  });
});

describe('isSameOriginMutation', () => {
  const host = 'desk.example.com';
  it('always allows safe methods', () => {
    expect(isSameOriginMutation({ method: 'GET', headers: {}, expectedHost: host })).toBe(true);
  });
  it('requires a matching Origin/Referer host for unsafe methods', () => {
    expect(
      isSameOriginMutation({
        method: 'POST',
        headers: { origin: 'https://desk.example.com' },
        expectedHost: host,
      })
    ).toBe(true);
    expect(
      isSameOriginMutation({
        method: 'POST',
        headers: { origin: 'https://evil.example' },
        expectedHost: host,
      })
    ).toBe(false);
    expect(
      isSameOriginMutation({
        method: 'POST',
        headers: { referer: 'https://desk.example.com/x' },
        expectedHost: host,
      })
    ).toBe(true);
    expect(isSameOriginMutation({ method: 'POST', headers: {}, expectedHost: host })).toBe(false);
    expect(
      isSameOriginMutation({
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin' },
        expectedHost: host,
      })
    ).toBe(true);
    expect(
      isSameOriginMutation({
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site', origin: 'https://desk.example.com' },
        expectedHost: host,
      })
    ).toBe(false);
  });
});

describe('peekSessionExpiry', () => {
  const token = (exp: number) =>
    `kys1.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`;
  it('reads exp without verifying (UX only)', () => {
    expect(peekSessionExpiry(token(Math.floor(Date.now() / 1000) + 60))).toBe('valid');
    expect(peekSessionExpiry(token(Math.floor(Date.now() / 1000) - 60))).toBe('expired');
    expect(peekSessionExpiry('kys1.@@@.sig')).toBe('malformed');
    expect(peekSessionExpiry('nope')).toBe('malformed');
  });
});

describe('extractSurfaceCredential', () => {
  it('prefers the Authorization header over the session cookie and reports the source', () => {
    expect(
      extractSurfaceCredential({ authorization: 'Bearer abc', cookie: 'kyberion_session=kys1.x.y' })
    ).toEqual({
      token: 'abc',
      source: 'header',
    });
    expect(extractSurfaceCredential({ cookie: 'kyberion_session=kys1.x.y' })).toEqual({
      token: 'kys1.x.y',
      source: 'session-cookie',
    });
    expect(extractSurfaceCredential({})).toEqual({ token: '', source: 'none' });
  });
});

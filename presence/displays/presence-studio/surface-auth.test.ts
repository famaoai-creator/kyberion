import type { AddressInfo } from 'node:net';
import { request, type Server } from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID_SESSION = `kys1.${Buffer.from(
  JSON.stringify({ iss: 'kyberion-browser-session', exp: Math.floor(Date.now() / 1000) + 3600 })
).toString('base64url')}.sig`;

vi.mock('@agent/core/surface/surface-authn', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agent/core/surface/surface-authn')>();
  return {
    ...original,
    resolveAuthnSurfaceViewerScope: (options: { token?: string }) => {
      if (options.token === VALID_SESSION) {
        return {
          scope: { tenantSlugs: 'all', source: 'token', principalId: 'human:member' },
          principal: undefined,
        };
      }
      return (original.resolveAuthnSurfaceViewerScope as (o: unknown) => unknown)(options);
    },
  };
});

import { presenceStudioLoginRedirect, registerPresenceStudioAuthRoutes } from './surface-auth.js';
import { requirePresenceStudioAccess, requirePresenceStudioRateLimit } from './security.js';

const ENV_KEYS = [
  'PRESENCE_STUDIO_ALLOW_REMOTE',
  'PRESENCE_STUDIO_TOKEN',
  'KYBERION_API_TOKEN',
  'KYBERION_OIDC_ISSUER',
];

let server: Server;
let base = '';
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  const app = express();
  // Test seam: simulate a non-loopback socket peer (the real code reads the socket, not Host).
  app.use((req, _res, next) => {
    if (req.headers['x-test-peer']) {
      Object.defineProperty(req.socket, 'remoteAddress', {
        value: String(req.headers['x-test-peer']),
        configurable: true,
      });
    }
    next();
  });
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  registerPresenceStudioAuthRoutes(app);
  app.use(presenceStudioLoginRedirect());
  app.get('/', (_req, res) => res.type('html').send('<html>home</html>'));
  app.get('/favicon.ico', (_req, res) => res.send('icon'));
  app.use(express.json());
  app.use(['/api', '/a2ui'], requirePresenceStudioRateLimit(), requirePresenceStudioAccess());
  app.get('/api/me', (_req, res) => res.json({ ok: true }));
  app.post('/api/me', (_req, res) => res.json({ ok: true }));
  app.post('/api/other', (_req, res) => res.json({ ok: true }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const REMOTE = { 'x-test-peer': '203.0.113.9' };
const NAV = { accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate' };

// node:http (not fetch): undici forces `Sec-Fetch-Mode: cors`, which would mask navigations.
function get(path: string, headers: Record<string, string> = {}) {
  return new Promise<{
    status: number;
    headers: { get: (name: string) => string | null };
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>((resolve, reject) => {
    const req = request(`${base}${path}`, { method: 'GET', headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          headers: {
            get: (name) => {
              const value = res.headers[name.toLowerCase()];
              return Array.isArray(value) ? value.join(', ') : (value ?? null);
            },
          },
          json: async () => JSON.parse(text),
          text: async () => text,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('presence-studio browser login redirect', () => {
  beforeEach(() => {
    process.env.PRESENCE_STUDIO_ALLOW_REMOTE = 'true';
    process.env.PRESENCE_STUDIO_TOKEN = 'static-token';
  });

  it('redirects an unauthenticated remote page navigation to /login?next=', async () => {
    const res = await get('/', { ...REMOTE, ...NAV });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
    const deep = await get('/work?tab=2', { ...REMOTE, ...NAV });
    expect(deep.status).toBe(302);
    expect(deep.headers.get('location')).toBe('/login?next=%2Fwork%3Ftab%3D2');
  });

  it('leaves loopback untouched', async () => {
    const res = await get('/', NAV);
    expect(res.status).toBe(200);
  });

  it('leaves API calls on JSON 401', async () => {
    const res = await get('/api/me', { ...REMOTE, ...NAV });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('leaves public asset paths untouched', async () => {
    const res = await get('/favicon.ico', { ...REMOTE, ...NAV });
    expect(res.status).toBe(200);
  });

  it('passes a credentialed navigation (bearer header or valid session cookie)', async () => {
    const bearer = await get('/', { ...REMOTE, ...NAV, authorization: 'Bearer static-token' });
    expect(bearer.status).toBe(200);
    const cookie = await get('/', {
      ...REMOTE,
      ...NAV,
      cookie: `kyberion_session=${VALID_SESSION}`,
    });
    expect(cookie.status).toBe(200);
  });

  it('does not redirect (no loop) when remote access is disabled', async () => {
    delete process.env.PRESENCE_STUDIO_ALLOW_REMOTE;
    delete process.env.PRESENCE_STUDIO_TOKEN;
    const res = await get('/', { ...REMOTE, ...NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    const api = await get('/api/me', REMOTE);
    expect(api.status).toBe(403);
  });
});

describe('presence-studio /login', () => {
  it('serves the HTML page with security headers and names the missing OIDC config', async () => {
    const res = await get('/login', REMOTE);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toContain('KYBERION_OIDC_ISSUER');
  });
});

describe('presence-studio session cookie credential', () => {
  beforeEach(() => {
    process.env.PRESENCE_STUDIO_ALLOW_REMOTE = 'true';
    process.env.PRESENCE_STUDIO_TOKEN = 'static-token';
  });

  it('accepts a valid session cookie on an allowlisted API path', async () => {
    const res = await get('/api/me', { ...REMOTE, cookie: `kyberion_session=${VALID_SESSION}` });
    expect(res.status).toBe(200);
  });

  it('rejects an invalid session cookie with 401', async () => {
    const res = await get('/api/me', { ...REMOTE, cookie: 'kyberion_session=kys1.bogus.bogus' });
    expect(res.status).toBe(401);
  });

  it('keeps the remote-safe allowlist for session viewers', async () => {
    const res = await fetch(`${base}/api/other`, {
      method: 'POST',
      headers: { ...REMOTE, cookie: `kyberion_session=${VALID_SESSION}`, origin: base },
    });
    expect(res.status).toBe(403);
  });

  it('blocks a cross-origin cookie-authenticated mutation', async () => {
    const res = await fetch(`${base}/api/me`, {
      method: 'POST',
      headers: {
        ...REMOTE,
        cookie: `kyberion_session=${VALID_SESSION}`,
        origin: 'https://evil.example',
      },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'Cross-origin request blocked.' });
  });

  it('allows a same-origin cookie mutation', async () => {
    const res = await fetch(`${base}/api/me`, {
      method: 'POST',
      headers: { ...REMOTE, cookie: `kyberion_session=${VALID_SESSION}`, origin: base },
    });
    expect(res.status).toBe(200);
  });

  it('does not apply the same-origin check to header bearer auth', async () => {
    const res = await fetch(`${base}/api/me`, {
      method: 'POST',
      headers: {
        ...REMOTE,
        authorization: 'Bearer static-token',
        origin: 'https://evil.example',
      },
    });
    expect(res.status).toBe(200);
  });
});

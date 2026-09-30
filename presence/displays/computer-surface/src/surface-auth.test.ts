import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const scopeSpy = vi.hoisted(() => vi.fn());
vi.mock('@agent/core/surface/surface-authn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/surface/surface-authn')>();
  return { ...actual, resolveAuthnSurfaceViewerScope: scopeSpy };
});

import {
  assertComputerSurfaceCookieMutationSafe,
  resolveComputerSurfaceViewerContext,
} from '../auth.js';
import {
  computerSurfaceLoginRedirect,
  registerComputerSurfaceAuthRoutes,
} from '../surface-auth.js';

const REMOTE = { 'x-forwarded-for': '10.0.0.5' };
const HTML = { accept: 'text/html', 'sec-fetch-mode': 'navigate' };

// undici fetch forces Sec-Fetch-Mode, so drive raw HTTP to emulate a navigation.
function get(
  base: string,
  path: string,
  headers: Record<string, string>
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}> {
  return new Promise((resolve, reject) => {
    const r = httpRequest(`${base}${path}`, { headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function withApp<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  registerComputerSurfaceAuthRoutes(app);
  app.use(computerSurfaceLoginRedirect());
  app.get('/', (_req, res) => res.send('page'));
  app.get('/api/x', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

function req(headers: Record<string, string>, method = 'GET') {
  return { method, socket: { remoteAddress: '10.0.0.5' } as any, headers };
}

afterEach(() => {
  vi.unstubAllEnvs();
  scopeSpy.mockReset();
});

describe('computer-surface login redirect', () => {
  it('redirects unauthenticated remote navigations to /login?next', async () => {
    await withApp(async (base) => {
      const res = await get(base, '/os/panel', { ...REMOTE, ...HTML });
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/^\/login\?next=/u);
    });
  });

  it('leaves loopback, API and credentialed requests untouched', async () => {
    await withApp(async (base) => {
      expect((await get(base, '/', HTML)).status).toBe(200);
      const api = await get(base, '/api/x', { ...REMOTE, ...HTML });
      expect(api.status).toBe(200);
      const bearer = await get(base, '/', { ...REMOTE, ...HTML, authorization: 'Bearer t' });
      expect(bearer.status).toBe(200);
    });
  });

  it('serves /login unauthenticated as HTML with security headers', async () => {
    vi.stubEnv('KYBERION_OIDC_ISSUER', '');
    await withApp(async (base) => {
      const res = await get(base, '/login', { ...REMOTE, ...HTML });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.text).toContain('KYBERION_OIDC_ISSUER');
    });
  });
});

describe('computer-surface session cookie credential', () => {
  const scope = {
    role: 'readonly',
    source: 'token',
    tenantSlugs: ['tenant-a'],
    tierAccess: ['public'],
  };

  it('passes the cookie kys1 value where the bearer goes; header wins', () => {
    scopeSpy.mockReturnValue({ scope, principal: { id: 'p' } });
    resolveComputerSurfaceViewerContext(req({ cookie: 'kyberion_session=kys1.abc.def' }));
    expect(scopeSpy.mock.calls[0][0].token).toBe('kys1.abc.def');
    resolveComputerSurfaceViewerContext(
      req({ cookie: 'kyberion_session=kys1.abc.def', authorization: 'Bearer hdr' })
    );
    expect(scopeSpy.mock.calls[1][0].token).toBe('hdr');
  });

  it('rejects cross-origin cookie mutations but not header-authenticated ones', () => {
    const cookie = 'kyberion_session=kys1.abc.def';
    const base = { cookie, host: 'surface.example' };
    expect(() =>
      assertComputerSurfaceCookieMutationSafe(
        req({ ...base, origin: 'https://evil.example' }, 'POST')
      )
    ).toThrow('Cross-origin');
    expect(() =>
      assertComputerSurfaceCookieMutationSafe(
        req({ ...base, origin: 'https://surface.example' }, 'POST')
      )
    ).not.toThrow();
    expect(() =>
      assertComputerSurfaceCookieMutationSafe(
        req({ ...base, origin: 'https://evil.example', authorization: 'Bearer t' }, 'POST')
      )
    ).not.toThrow();
  });
});

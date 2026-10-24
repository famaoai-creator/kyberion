import express from 'express';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { resolveRoomTenant } from '../../server.js';
import type { FacadeOutcome, FacadeSpawner, FacadeVerb } from './facade.js';
import { CONTENT_SECURITY_POLICY, MAX_BODY_BYTES, registerCustomerRoomRoutes } from './routes.js';

const TOKEN = 'inv-0123456789abcdef.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';

interface Call {
  verb: FacadeVerb;
  input: Record<string, unknown>;
}

describe('customer-room routes', () => {
  let server: Server;
  let base: string;
  let calls: Call[];
  let logs: string[];
  let next: () => Promise<FacadeOutcome>;
  let jsDir: string;

  const spawner: FacadeSpawner = async (verb, input) => {
    calls.push({ verb, input });
    return next();
  };
  const out = (body: unknown, status = 0): Promise<FacadeOutcome> =>
    Promise.resolve({ status, stdout: JSON.stringify(body), aborted: false });

  async function start(limits: { api?: number; page?: number } = {}): Promise<void> {
    const app = express();
    registerCustomerRoomRoutes(app, {
      spawner,
      staticDir: new URL('../../static', import.meta.url).pathname,
      jsDir,
      renderPage: () => '<!doctype html><title>room</title>',
      log: (message) => logs.push(message),
      apiLimitPerMinute: limits.api,
      pageLimitPerMinute: limits.page,
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const post = (path: string, init: { token?: string | null; body?: unknown; raw?: string } = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(init.token === null ? {} : { Authorization: `Bearer ${init.token ?? TOKEN}` }),
      },
      body: init.raw ?? JSON.stringify(init.body ?? {}),
    });

  beforeEach(() => {
    calls = [];
    logs = [];
    jsDir = pathResolver.sharedTmp(`customer-room-js-${randomUUID()}`);
    safeMkdir(jsDir, { recursive: true });
    safeWriteFile(`${jsDir}/main.js`, 'export {};', { encoding: 'utf8' });
    safeWriteFile(`${jsDir}/main.test.js`, 'export {};', { encoding: 'utf8' });
    next = () => out({ ok: true, state: 'open' });
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    safeRmSync(jsDir, { recursive: true, force: true });
  });

  it('serves only the listed routes', async () => {
    await start();
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const page = await fetch(`${base}/r`);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect((await fetch(`${base}/assets/app.css`)).status).toBe(200);
    expect((await fetch(`${base}/js/app/main.js`)).status).toBe(200);
    for (const path of [
      '/js/app/main.test.js',
      '/js/app/main.js.map',
      '/js/server/routes.js',
      '/js/app/../x.js',
      '/js/main.js',
    ]) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(404);
    }
    for (const path of [
      '/',
      '/index.html',
      '/api',
      '/api/health',
      '/api/view',
      '/api/respond',
      '/api/agendas',
      '/api/state',
      '/assets/index.html',
      '/assets/../server.ts',
      '/static/app.css',
      '/admin',
      '/r/extra',
    ]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(404);
    }
    expect((await fetch(`${base}/api/view`, { method: 'PUT' })).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('sets the security headers on every answer', async () => {
    await start();
    for (const path of ['/health', '/r', '/nope']) {
      const response = await fetch(`${base}${path}`);
      expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-inline');
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    const api = await post('/api/view');
    expect(api.headers.get('cache-control')).toBe('no-store');
  });

  it('requires the token in the Authorization header and ignores the query string', async () => {
    await start();
    const queryOnly = await post(`/api/view?token=${TOKEN}&t=${TOKEN}`, { token: null });
    expect(queryOnly.status).toBe(404);
    expect(await queryOnly.json()).toEqual({ ok: false, reason: 'invalid_link' });
    const bodyOnly = await post('/api/view', { token: null, body: { token: TOKEN } });
    expect(bodyOnly.status).toBe(404);
    const malformed = await post('/api/view', { token: 'not-a-token' });
    expect(malformed.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('passes the header token to the facade and maps success', async () => {
    await start();
    next = () => out({ ok: true, state: 'open', entries: [] });
    const response = await post('/api/view', { body: { token: 'ignored', tenant: 'evil' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, state: 'open' });
    expect(calls).toEqual([{ verb: 'view', input: { token: TOKEN } }]);
  });

  it('forwards only content_hash and answers on respond; the tenant is never taken from a request', async () => {
    await start();
    next = () => out({ ok: true, receipt_id: 'rcp-1', switches: 0, change_requests: 0 });
    const answers = [{ entry_id: 'a', choice: 'keep' }];
    const response = await post(`/api/respond?tenant=evil`, {
      body: { content_hash: 'h', answers, tenant: 'evil', case: 'other', dir: '/tmp/x' },
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { verb: 'respond', input: { token: TOKEN, content_hash: 'h', answers } },
    ]);
    const bad = await post('/api/respond', { body: { answers: 'x' } });
    expect(bad.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['invalid_link', 404],
    ['expired', 410],
    ['revoked', 410],
    ['closed', 410],
    ['updating', 409],
    ['stale_version', 409],
    ['invalid_answers', 422],
    ['not_entitled', 403],
    ['invalid_request', 400],
    ['unavailable', 503],
    ['some_internal_code', 503],
  ])('maps reason %s to HTTP %i', async (reason, status) => {
    await start();
    next = () => out({ ok: false, reason, internal: 'secret-detail' }, 1);
    const response = await post('/api/view');
    expect(response.status).toBe(status);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.reason).toBe(status === 503 ? 'unavailable' : reason);
    expect(body).not.toHaveProperty('internal');
  });

  it('passes per-item answer errors through for invalid_answers only', async () => {
    await start();
    next = () =>
      out(
        {
          ok: false,
          reason: 'invalid_answers',
          errors: [{ entry_id: 'a', error: 'text_required' }],
        },
        1
      );
    const response = await post('/api/respond', { body: { content_hash: 'h', answers: [] } });
    expect(await response.json()).toEqual({
      ok: false,
      reason: 'invalid_answers',
      errors: [{ entry_id: 'a', error: 'text_required' }],
    });
  });

  it('answers unavailable on timeout, garbage output, empty output and spawn failure', async () => {
    await start();
    for (const outcome of [
      () => Promise.resolve({ status: 1, stdout: '', aborted: true }),
      () => Promise.resolve({ status: 0, stdout: 'not json', aborted: false }),
      () => Promise.resolve({ status: 1, stdout: '', aborted: false }),
      () => Promise.reject(new Error('boom')),
    ]) {
      next = outcome as () => Promise<FacadeOutcome>;
      const response = await post('/api/view');
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, reason: 'unavailable' });
    }
  });

  it('enforces the body size limit', async () => {
    await start();
    const big = 'x'.repeat(MAX_BODY_BYTES + 10);
    const response = await post('/api/respond', { body: { content_hash: 'h', answers: [big] } });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, reason: 'invalid_request' });
    const malformed = await post('/api/view', { raw: '{nope' });
    expect(malformed.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('rate limits per client address', async () => {
    await start({ api: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await post('/api/view')).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect(await (await post('/api/view')).json()).toEqual({ ok: false, reason: 'unavailable' });
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('never logs or echoes the token', async () => {
    await start();
    next = () => out({ ok: false, reason: 'expired' }, 1);
    const response = await post(`/api/view?token=${TOKEN}`);
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.stringify([...response.headers])).not.toContain(TOKEN);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain('inv-');
  });
});

describe('customer-room tenant', () => {
  it('requires a valid slug', () => {
    expect(resolveRoomTenant(undefined)).toBeNull();
    expect(resolveRoomTenant('')).toBeNull();
    expect(resolveRoomTenant('Bad Slug')).toBeNull();
    expect(resolveRoomTenant('../etc')).toBeNull();
    expect(resolveRoomTenant('acme-corp')).toBe('acme-corp');
  });
});

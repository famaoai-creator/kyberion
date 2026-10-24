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
      '/api/attachment',
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
    // blob: only for images (the page shows fetched attachments from object URLs).
    expect(CONTENT_SECURITY_POLICY).toContain("img-src 'self' data: blob:");
    expect(CONTENT_SECURITY_POLICY.match(/blob:/gu)).toHaveLength(1);
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

  it('forwards general_question untouched (the facade validates it) and allows an empty answer list', async () => {
    await start();
    next = () => out({ ok: true, receipt_id: 'rcp-1', switches: 0, change_requests: 0 });
    const ok = await post('/api/respond', {
      body: { content_hash: 'h', answers: [], general_question: '予算の上限は?', tenant: 'evil' },
    });
    expect(ok.status).toBe(200);
    expect(calls[0]).toEqual({
      verb: 'respond',
      input: { token: TOKEN, content_hash: 'h', answers: [], general_question: '予算の上限は?' },
    });
    // A non-string question still reaches the facade, which rejects it.
    next = () =>
      out({
        ok: false,
        reason: 'invalid_answers',
        errors: [{ entry_id: '', error: 'choice_invalid' }],
      });
    const bad = await post('/api/respond', {
      body: { content_hash: 'h', answers: [], general_question: 42 },
    });
    expect(bad.status).toBe(422);
    expect(calls[1].input).toMatchObject({ general_question: 42 });
  });

  it('accepts the largest allowed question inside the body cap', async () => {
    await start();
    next = () => out({ ok: true, receipt_id: 'rcp-1', switches: 0, change_requests: 0 });
    // 10000 Japanese characters are about 30 KB of UTF-8, well inside 64 KB.
    const question = 'あ'.repeat(10000);
    const response = await post('/api/respond', {
      body: { content_hash: 'h', answers: [], general_question: question },
    });
    expect(response.status).toBe(200);
    expect(calls[0].input).toMatchObject({ general_question: question });
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

  it('logs the facade diagnostic code of an unexpected failure, never sends it to the customer', async () => {
    await start();
    next = () => out({ ok: false, reason: 'unavailable', diagnostic_code: 'LOCK_TIMEOUT' }, 1);
    const failed = await post('/api/respond', { body: { content_hash: 'h', answers: [] } });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ ok: false, reason: 'unavailable' });
    expect(logs.at(-1)).toBe(
      '[customer-room] respond -> 503 unavailable (diagnostic: LOCK_TIMEOUT)'
    );
    // A child that died without an answer is logged with why.
    next = () => Promise.resolve({ status: 1, stdout: '', aborted: false });
    await post('/api/view');
    expect(logs.at(-1)).toBe(
      '[customer-room] view -> 503 unavailable (diagnostic: child_exit_1_no_output)'
    );
    next = () => Promise.resolve({ status: null, stdout: '', aborted: true });
    await post('/api/view');
    expect(logs.at(-1)).toContain('(diagnostic: child_aborted)');
    // A malformed code is not logged as one.
    next = () => out({ ok: false, reason: 'unavailable', diagnostic_code: 'x y\nz' }, 1);
    await post('/api/view');
    expect(logs.at(-1)).toBe('[customer-room] view -> 503 unavailable');
  });
});

describe('customer-room attachment route', () => {
  let server: Server;
  let base: string;
  let calls: Call[];
  let logs: string[];
  let next: () => Promise<FacadeOutcome>;
  const ID = 'ab'.repeat(32);
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('rest-of-image'),
  ]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  const out = (body: unknown, status = 0): Promise<FacadeOutcome> =>
    Promise.resolve({ status, stdout: JSON.stringify(body), aborted: false });
  const image = (mediaType: string, bytes: Buffer) =>
    out({ ok: true, media_type: mediaType, bytes_base64: bytes.toString('base64') });

  beforeEach(() => {
    calls = [];
    logs = [];
    next = () => image('image/png', PNG);
  });
  async function start(
    apiLimitPerMinute = 100,
    attachment: { perMinute?: number; concurrency?: number } = {}
  ): Promise<void> {
    const app = express();
    registerCustomerRoomRoutes(app, {
      spawner: async (verb, input) => {
        calls.push({ verb, input });
        return next();
      },
      staticDir: new URL('../../static', import.meta.url).pathname,
      jsDir: new URL('../../static', import.meta.url).pathname,
      renderPage: () => '',
      log: (message) => logs.push(message),
      apiLimitPerMinute,
      attachmentLimitPerMinute: attachment.perMinute,
      attachmentConcurrency: attachment.concurrency,
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const fetchImage = (body: unknown, token: string | null = TOKEN, query = '') =>
    fetch(`${base}/api/attachment${query}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });

  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/webp', WEBP],
  ])('serves %s bytes with a fixed type, nosniff, inline and no-store', async (type, bytes) => {
    await start();
    next = () => image(type, bytes);
    const response = await fetchImage({ attachment_id: ID, tenant: 'evil', token: 'x' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(type);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toBe('inline');
    expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    // Only the header token and the id reach the facade.
    expect(calls).toEqual([{ verb: 'attachment', input: { token: TOKEN, attachment_id: ID } }]);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('takes the token from the Authorization header only and checks the id shape', async () => {
    await start();
    for (const [body, token, query, status] of [
      [{ attachment_id: ID }, null, `?token=${TOKEN}`, 404],
      [{ attachment_id: ID, token: TOKEN }, null, '', 404],
      [{ attachment_id: ID }, 'not-a-token', '', 404],
      [{ attachment_id: '../../etc/passwd' }, TOKEN, '', 400],
      [{ attachment_id: ID.toUpperCase() }, TOKEN, '', 400],
      [{ attachment_id: `${ID}0` }, TOKEN, '', 400],
      [{}, TOKEN, '', 400],
    ] as const) {
      const response = await fetchImage(body, token, query);
      expect(response.status, JSON.stringify(body)).toBe(status);
      expect(response.headers.get('content-type')).toContain('application/json');
    }
    expect(calls).toEqual([]);
  });

  it.each([
    ['invalid_link', 404],
    ['expired', 410],
    ['revoked', 410],
    ['some_internal_code', 503],
  ])('maps facade reason %s to the view shape and HTTP %i', async (reason, status) => {
    await start();
    next = () => out({ ok: false, reason }, 1);
    const response = await fetchImage({ attachment_id: ID });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      ok: false,
      reason: status === 503 ? 'unavailable' : reason,
    });
  });

  it('refuses anything that is not an allowlisted, in-limit image', async () => {
    await start();
    const big = Buffer.concat([PNG, Buffer.alloc(512 * 1024)]);
    for (const outcome of [
      () => image('image/svg+xml', Buffer.from('<svg onload=alert(1)>')),
      () => image('text/html', PNG),
      () => image('image/png', JPEG),
      () => image('image/jpeg', Buffer.from('<html>')),
      () => image('image/png', big),
      () => out({ ok: true, media_type: 'image/png', bytes_base64: 'not base64!' }),
      () => out({ ok: true, media_type: 'image/png', bytes_base64: '' }),
      () => out({ ok: true, media_type: 'image/png' }),
      () => Promise.resolve({ status: null, stdout: '', aborted: true }),
    ]) {
      next = outcome;
      const response = await fetchImage({ attachment_id: ID });
      expect(response.status).toBe(503);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({ ok: false, reason: 'unavailable' });
    }
    expect(logs.at(-2)).toBe(
      '[customer-room] attachment -> 503 unavailable (diagnostic: attachment_not_servable)'
    );
  });

  it('has its own per-address budget, separate from the view/respond budget', async () => {
    await start(2, { perMinute: 5 });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await fetchImage({ attachment_id: ID })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
    const limited = await fetchImage({ attachment_id: ID });
    expect(limited.headers.get('cache-control')).toBe('no-store');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({ ok: false, reason: 'unavailable' });
    expect(calls).toHaveLength(5);
    // Images did not use the API budget: view still answers.
    next = () => out({ ok: true, state: 'open' });
    const view = await fetch(`${base}/api/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: '{}',
    });
    expect(view.status).toBe(200);
  });

  it('caps image fetches in flight and frees the slot when one finishes', async () => {
    await start(100, { perMinute: 100, concurrency: 2 });
    const pending: Array<() => void> = [];
    next = () =>
      new Promise<FacadeOutcome>((resolve) => {
        pending.push(() =>
          resolve({
            status: 0,
            stdout: JSON.stringify({
              ok: true,
              media_type: 'image/png',
              bytes_base64: PNG.toString('base64'),
            }),
            aborted: false,
          })
        );
      });
    const first = fetchImage({ attachment_id: ID });
    const second = fetchImage({ attachment_id: ID });
    await expect.poll(() => pending.length).toBe(2);
    const third = await fetchImage({ attachment_id: ID });
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe('1');
    expect(calls).toHaveLength(2);
    pending.shift()?.();
    expect((await first).status).toBe(200);
    const fourth = fetchImage({ attachment_id: ID });
    await expect.poll(() => pending.length).toBe(2);
    for (const resolve of pending.splice(0)) resolve();
    expect((await second).status).toBe(200);
    expect((await fourth).status).toBe(200);
  });

  it('keeps the slot of a dropped request until its facade run settles', async () => {
    await start(100, { perMinute: 100, concurrency: 1 });
    let settle: (() => void) | undefined;
    next = () =>
      new Promise<FacadeOutcome>((resolve) => {
        settle = () =>
          resolve({
            status: 0,
            stdout: JSON.stringify({
              ok: true,
              media_type: 'image/png',
              bytes_base64: PNG.toString('base64'),
            }),
            aborted: false,
          });
      });
    let closed = 0;
    server.on('connection', (socket) => socket.once('close', () => (closed += 1)));
    const controller = new AbortController();
    const dropped = fetch(`${base}/api/attachment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ attachment_id: ID }),
      signal: controller.signal,
    }).catch(() => null);
    await expect.poll(() => settle !== undefined).toBe(true);
    controller.abort();
    await dropped;
    // The server saw the client go away (its socket closed) before the next request.
    await expect.poll(() => closed).toBeGreaterThan(0);
    // The child still runs: the cap holds even though the client went away.
    expect((await fetchImage({ attachment_id: ID })).status).toBe(429);
    expect(calls).toHaveLength(1);
    settle?.();
    next = () => image('image/png', PNG);
    await expect.poll(async () => (await fetchImage({ attachment_id: ID })).status).toBe(200);
  });

  it('does not count refused requests against the in-flight cap', async () => {
    await start(100, { perMinute: 100, concurrency: 1 });
    for (let i = 0; i < 3; i += 1) {
      expect((await fetchImage({ attachment_id: 'bad' })).status).toBe(400);
    }
    expect((await fetchImage({ attachment_id: ID })).status).toBe(200);
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

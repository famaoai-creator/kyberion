import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../framework/actions.js';
import { isAllowedProviderBase, parseProviders } from './providers.js';
import { CONTENT_SECURITY_POLICY, registerA2UIHostRoutes } from './routes.js';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

const recorded: Recorded[] = [];
let upstreamStatus = 200;
let upstreamBody: unknown = { ok: true };
let upstreamJson = true;

const fakeUpstream: FetchLike = async (url, init) => {
  recorded.push({
    url,
    method: init?.method ?? 'GET',
    headers: (init?.headers as Record<string, string>) ?? {},
    body: typeof init?.body === 'string' ? init.body : undefined,
  });
  if (url.includes('/api/headless/manifest')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        manifest: {
          surface: 'presence-studio',
          resources: [
            {
              resource: 'overview',
              description: 'Overview',
              query_path: '/api/headless/overview',
              a2ui_path: '/api/headless/a2ui/overview',
            },
            { resource: 'plain', description: 'No projection', query_path: '/api/headless/plain' },
            { resource: 'surface-state', description: 'Mirror', query_path: '/api/state' },
            {
              resource: 'evil',
              description: 'Bad path',
              query_path: '/x',
              a2ui_path: 'https://evil.example/api',
            },
          ],
          operations: [
            {
              operation_id: 'x.state.read',
              method: 'GET',
              path: '/api/state',
              a2ui_projection: true,
              description: 'State',
            },
            {
              operation_id: 'x.stream.read',
              method: 'GET',
              path: '/api/stream',
              a2ui_projection: true,
              description: 'Stream',
            },
            {
              operation_id: 'x.overview',
              method: 'GET',
              path: '/api/headless/a2ui/overview',
              a2ui_projection: true,
              description: 'dup',
            },
            {
              operation_id: 'x.dispatch',
              method: 'POST',
              path: '/api/dispatch',
              a2ui_projection: true,
              description: 'write',
            },
            {
              operation_id: 'x.plain',
              method: 'GET',
              path: '/api/plain',
              a2ui_projection: false,
              description: 'no',
            },
            {
              operation_id: 'x.overview.query',
              method: 'GET',
              path: '/api/headless/overview',
              a2ui_projection: true,
              description: 'query variant of a projected resource',
            },
          ],
        },
      }),
    } as unknown as Response;
  }
  if (url.includes('/api/components')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        components: [
          {
            id: 'hearing',
            title: 'Hearing',
            summary: 'Q&A',
            a2ui_path: '/api/headless/a2ui/hearing',
          },
          { id: 'page', title: 'Page' },
        ],
      }),
    } as unknown as Response;
  }
  return {
    ok: upstreamStatus < 400,
    status: upstreamStatus,
    json: async () => {
      if (!upstreamJson) throw new Error('not json');
      return upstreamBody;
    },
  } as unknown as Response;
};

let baseUrl = '';
let server: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  const app = express();
  registerA2UIHostRoutes(app, {
    providers: [{ id: 'studio', baseUrl: 'http://127.0.0.1:65530' }],
    staticDir: process.cwd() + '/presence/displays/a2ui-host/static',
    jsDir: process.cwd() + '/presence/displays/a2ui-host/src',
    fetchImpl: fakeUpstream,
    timeoutMs: 2000,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('providers', () => {
  it('parses id=base pairs, keeps loopback origins only and falls back to defaults', () => {
    const skipped: string[] = [];
    const providers = parseProviders(
      'studio=http://127.0.0.1:3031/, bad, evil=https://example.com, x=ftp://127.0.0.1, Up=http://localhost:1, studio=http://localhost:2',
      (pair, reason) => skipped.push(`${pair}:${reason}`)
    );
    expect(providers).toEqual([{ id: 'studio', baseUrl: 'http://127.0.0.1:3031' }]);
    expect(skipped).toHaveLength(4);
    expect(parseProviders(undefined).map((provider) => provider.id)).toEqual([
      'presence-studio',
      'computer-surface',
    ]);
    expect(isAllowedProviderBase('http://[::1]:3031')).toBe(true);
    expect(isAllowedProviderBase('http://127.0.0.1:3031/path')).toBe(false);
    expect(isAllowedProviderBase('http://127.0.0.1:3031?x=1')).toBe(false);
  });
});

describe('host routes', () => {
  it('serves health, providers and security headers', async () => {
    const health = await fetch(`${baseUrl}/api/healthz`);
    expect(health.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(health.headers.get('x-frame-options')).toBe('DENY');
    expect(await health.json()).toEqual({ ok: true, surface: 'a2ui-host', providers: 1 });
    const providers = await (await fetch(`${baseUrl}/api/providers`)).json();
    expect(providers).toEqual({
      ok: true,
      providers: [{ id: 'studio', base_url: 'http://127.0.0.1:65530' }],
    });
  });

  it('serves the viewer page without inline scripts', async () => {
    const page = await fetch(`${baseUrl}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('/js/app/main.js');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/u);
    expect(html).not.toMatch(/\son[a-z]+=/u);
  });

  it('aggregates a provider catalog from the manifest and optional components', async () => {
    recorded.length = 0;
    const response = await fetch(`${baseUrl}/api/providers/studio/catalog`, {
      headers: { 'x-kyberion-tenant': 'acme' },
    });
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      provider: 'studio',
      surface: 'presence-studio',
      resources: [
        { resource: 'overview', description: 'Overview', a2ui_path: '/api/headless/a2ui/overview' },
        { resource: 'surface-state', description: 'Mirror', a2ui_path: '/api/state' },
      ],
      components: [
        {
          id: 'hearing',
          title: 'Hearing',
          summary: 'Q&A',
          a2ui_path: '/api/headless/a2ui/hearing',
        },
      ],
    });
    expect(recorded.map((call) => call.url).sort()).toEqual([
      'http://127.0.0.1:65530/api/components?tenant=acme',
      'http://127.0.0.1:65530/api/headless/manifest?tenant=acme',
    ]);
    expect(recorded[0].headers['x-kyberion-tenant']).toBe('acme');
    expect((await fetch(`${baseUrl}/api/providers/nope/catalog`)).status).toBe(404);
  });

  it('proxies GET and POST to provider /api/ paths with query, body and tenant header', async () => {
    recorded.length = 0;
    upstreamStatus = 200;
    upstreamBody = { ok: true, data: { a2ui: [] } };
    const get = await fetch(
      `${baseUrl}/api/providers/studio/proxy/api/headless/a2ui/hearing?session=s1&locale=ja`,
      {
        headers: { 'x-kyberion-tenant': 'acme' },
      }
    );
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual(upstreamBody);
    expect(recorded[0]).toMatchObject({
      url: 'http://127.0.0.1:65530/api/headless/a2ui/hearing?session=s1&locale=ja',
      method: 'GET',
    });
    expect(recorded[0].headers['x-kyberion-tenant']).toBe('acme');

    upstreamStatus = 201;
    upstreamBody = { ok: true };
    const post = await fetch(`${baseUrl}/api/providers/studio/proxy/api/hearing/s1/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(post.status).toBe(201);
    expect(recorded[1].method).toBe('POST');
    expect(JSON.parse(recorded[1].body ?? '{}')).toEqual({ text: 'hello' });
    expect(recorded[1].headers['x-kyberion-tenant']).toBeUndefined();
  });

  it('refuses unknown providers, non-api paths, other methods and passes upstream errors through', async () => {
    expect((await fetch(`${baseUrl}/api/providers/nope/proxy/api/x`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/providers/studio/proxy/other`)).status).toBe(400);
    expect(
      (await fetch(`${baseUrl}/api/providers/studio/proxy/api/x`, { method: 'DELETE' })).status
    ).toBe(405);

    upstreamStatus = 403;
    upstreamBody = { ok: false, error: 'forbidden' };
    const forbidden = await fetch(`${baseUrl}/api/providers/studio/proxy/api/x`);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual(upstreamBody);

    upstreamStatus = 200;
    upstreamJson = false;
    const nonJson = await fetch(`${baseUrl}/api/providers/studio/proxy/api/x`);
    expect(nonJson.status).toBe(502);
    upstreamJson = true;
  });
});

import { describe, it, expect, vi } from 'vitest';
import type { BrowserContext, Route } from '@playwright/test';
import {
  installIsolatedNavigationConfinement,
  permitIsolatedNavigation,
  hasIsolatedNavigationConfinement,
  installAuthenticatedOriginConfinement,
  authenticatedConfinementBlocks,
  authenticatedConfinementOrigins,
  authenticatedOriginLaunchArgs,
  normalizeConfinedOrigin,
} from './browser-navigation-confinement.js';

async function authenticatedFixture(origins = ['https://wf.example.jp']) {
  let handler!: (route: Route) => Promise<void>;
  let wsHandler!: (ws: unknown) => void;
  const context = {
    route: vi.fn(async (_pattern: string, callback: typeof handler) => {
      handler = callback;
    }),
    routeWebSocket: vi.fn(async (_matcher: unknown, callback: typeof wsHandler) => {
      wsHandler = callback;
    }),
    addInitScript: vi.fn(async () => undefined),
  } as unknown as BrowserContext;
  await installAuthenticatedOriginConfinement(context, origins);
  const request = async (
    url: string,
    status = 200,
    location?: string,
    method = 'POST',
    resourceType = 'document'
  ) => {
    const route = {
      request: () => ({ url: () => url, method: () => method, resourceType: () => resourceType }),
      fetch: vi.fn(async () => ({
        status: () => status,
        headers: () => (location ? { location } : {}),
      })),
      abort: vi.fn(async () => undefined),
      fulfill: vi.fn(async () => undefined),
    };
    await handler(route as unknown as Route);
    return route;
  };
  const socket = (url: string) => {
    const ws = { url: () => url, connectToServer: vi.fn(), close: vi.fn(async () => undefined) };
    wsHandler(ws);
    return ws;
  };
  return { context, request, socket };
}

describe('authenticated origin-set confinement', () => {
  it('lets scripts and form posts reach only the declared origins', async () => {
    const { context, request } = await authenticatedFixture();
    expect([...(authenticatedConfinementOrigins(context) ?? [])]).toEqual([
      'https://wf.example.jp',
    ]);
    const login = await request('https://wf.example.jp/login.aspx?ReturnUrl=%2F', 200);
    expect(login.fetch).toHaveBeenCalledExactlyOnceWith({ maxRedirects: 0, maxRetries: 0 });
    expect(login.fulfill).toHaveBeenCalledOnce();
  });
  it.each([
    'https://evil.example/collect',
    'http://wf.example.jp/login.aspx',
    'https://user:secret@wf.example.jp/',
    'https://wf.example.jp.evil.example/',
    'https://sub.wf.example.jp/',
  ])('aborts %s before transport', async (url) => {
    const { request } = await authenticatedFixture();
    const denied = await request(url);
    expect(denied.fetch).not.toHaveBeenCalled();
    expect(denied.abort).toHaveBeenCalledExactlyOnceWith('blockedbyclient');
  });
  it('hands back an in-set redirect and blocks one leaving the set', async () => {
    const { request } = await authenticatedFixture();
    const inside = await request('https://wf.example.jp/login.aspx', 302, '/sys/list.aspx');
    expect(inside.fulfill).toHaveBeenCalledOnce();
    expect(inside.abort).not.toHaveBeenCalled();
    const outside = await request('https://wf.example.jp/login.aspx', 302, 'https://evil.example/');
    expect(outside.fulfill).not.toHaveBeenCalled();
    expect(outside.abort).toHaveBeenCalledExactlyOnceWith('blockedbyclient');
    const missing = await request('https://wf.example.jp/login.aspx', 301);
    expect(missing.abort).toHaveBeenCalledExactlyOnceWith('blockedbyclient');
  });
  it('passes non-redirect 3xx responses such as 304 through', async () => {
    const { request } = await authenticatedFixture();
    const notModified = await request('https://wf.example.jp/app.js', 304);
    expect(notModified.fulfill).toHaveBeenCalledOnce();
    expect(notModified.abort).not.toHaveBeenCalled();
  });
  it('drops media and fonts the list never needs', async () => {
    const { request } = await authenticatedFixture();
    for (const type of ['media', 'font']) {
      const dropped = await request('https://wf.example.jp/a', 200, undefined, 'GET', type);
      expect(dropped.fetch).not.toHaveBeenCalled();
    }
  });
  it('records blocked requests by host name only', async () => {
    const { context, request, socket } = await authenticatedFixture();
    await request('https://cdn.example.net/app.js?token=SECRET');
    await request('https://wf.example.jp/login.aspx', 302, 'https://idp.example.com/sso?x=1');
    socket('wss://push.example.org/live');
    expect(authenticatedConfinementBlocks(context)).toEqual({
      count: 3,
      hosts: ['cdn.example.net', 'idp.example.com', 'push.example.org'],
    });
  });
  it('connects only in-set WebSockets', async () => {
    const { socket } = await authenticatedFixture();
    expect(socket('wss://wf.example.jp/live').connectToServer).toHaveBeenCalledOnce();
    const denied = socket('wss://evil.example/live');
    expect(denied.connectToServer).not.toHaveBeenCalled();
    expect(denied.close).toHaveBeenCalledOnce();
  });
  it('rejects non-origin declarations and an empty set', async () => {
    expect(() => normalizeConfinedOrigin('https://wf.example.jp/path')).toThrow(
      /Exact HTTPS origin/
    );
    expect(() => normalizeConfinedOrigin('http://wf.example.jp')).toThrow(/Exact HTTPS origin/);
    await expect(authenticatedFixture([])).rejects.toThrow(/At least one origin/);
  });
  it('is not recognized on a context it did not install', () => {
    expect(authenticatedConfinementOrigins({} as BrowserContext)).toBeUndefined();
  });
  it('disables peer connections before any page script runs', async () => {
    const { context } = await authenticatedFixture();
    expect(context.addInitScript).toHaveBeenCalledWith(
      expect.stringContaining('RTCPeerConnection')
    );
  });
  it('resolves only the declared hosts at the browser level', () => {
    expect(
      authenticatedOriginLaunchArgs(['https://wf.example.jp', 'https://sso.example.jp:8443'])
    ).toContain(
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE wf.example.jp, EXCLUDE sso.example.jp'
    );
  });
});

async function fixture() {
  let handler!: (route: Route) => Promise<void>;
  const context = {
    route: vi.fn(async (_pattern: string, callback: typeof handler) => {
      handler = callback;
    }),
  } as unknown as BrowserContext;
  await installIsolatedNavigationConfinement(context);
  const request = async (url: string, method = 'GET', status = 200) => {
    const route = {
      request: () => ({ url: () => url, method: () => method }),
      fetch: vi.fn(async () => ({
        status: () => status,
        headers: () => ({ location: 'https://evil.example/exfil' }),
      })),
      abort: vi.fn(async () => undefined),
      fulfill: vi.fn(async () => undefined),
    };
    await handler(route as unknown as Route);
    return route;
  };
  return { context, request };
}
describe('isolated browser network confinement', () => {
  it('denies all requests until actual shared admission and permits only a bound public read', async () => {
    const { context, request } = await fixture();
    expect(hasIsolatedNavigationConfinement(context)).toBe(true);
    expect((await request('https://example.com/public')).fetch).not.toHaveBeenCalled();
    permitIsolatedNavigation(context, 'https://example.com/public');
    const allowed = await request('https://example.com/public');
    expect(allowed.fetch).toHaveBeenCalledExactlyOnceWith({ maxRedirects: 0, maxRetries: 0 });
    expect(allowed.fulfill).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          'content-security-policy': expect.stringContaining("form-action 'none'"),
        }),
      })
    );
  });
  it.each([
    ['https://evil.example/subresource', 'GET'],
    ['https://example.com/submit', 'POST'],
    ['https://example.com/?secret=private', 'GET'],
    ['http://example.com/public', 'GET'],
    ['https://user:secret@example.com/public', 'GET'],
    ['file:///private/profile', 'GET'],
  ])('aborts %s %s before transport', async (url, method) => {
    const { context, request } = await fixture();
    permitIsolatedNavigation(context, 'https://example.com/public');
    const denied = await request(url, method);
    expect(denied.fetch).not.toHaveBeenCalled();
    expect(denied.abort).toHaveBeenCalledExactlyOnceWith('blockedbyclient');
  });
  it.each([301, 302, 303, 307, 308])(
    'cannot follow HTTP redirect %i to another destination',
    async (status) => {
      const { context, request } = await fixture();
      permitIsolatedNavigation(context, 'https://example.com/public');
      const redirected = await request('https://example.com/public', 'GET', status);
      expect(redirected.fetch).toHaveBeenCalledExactlyOnceWith({ maxRedirects: 0, maxRetries: 0 });
      expect(redirected.fulfill).not.toHaveBeenCalled();
      expect(redirected.abort).toHaveBeenCalledExactlyOnceWith('blockedbyclient');
    }
  );
  it('does not recognize caller JSON or reused unconfined contexts as a capability', () => {
    expect(
      hasIsolatedNavigationConfinement({
        navigation_confinement: 'isolated-public-read-v1',
      } as unknown as BrowserContext)
    ).toBe(false);
  });
});

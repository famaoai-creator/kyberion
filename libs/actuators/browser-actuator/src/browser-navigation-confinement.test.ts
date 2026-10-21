import { describe, it, expect, vi } from 'vitest';
import type { BrowserContext, Route } from '@playwright/test';
import {
  installIsolatedNavigationConfinement,
  permitIsolatedNavigation,
  hasIsolatedNavigationConfinement,
} from './browser-navigation-confinement.js';

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

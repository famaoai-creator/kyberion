import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frontDeskFetch, isFrontDeskMemberApiPath } from './front-desk-fetch';
import {
  attachFrontDeskAuthHeaders,
  clearFrontDeskToken,
  getStoredFrontDeskToken,
  storeFrontDeskToken,
} from './front-desk-auth-token';
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  vi.stubGlobal('window', {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  vi.stubGlobal('document', { cookie: '' });
  clearFrontDeskToken();
});
afterEach(() => vi.unstubAllGlobals());
const response = () =>
  new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
const mockRequest = () => {
  const request = vi.fn(async (_path: string, _init?: RequestInit) => response());
  vi.stubGlobal('fetch', request);
  return request;
};
describe('member API transport', () => {
  it('never dispatches anonymously when storage is blocked or a token save fails', async () => {
    const request = mockRequest();
    vi.stubGlobal('window', {
      get sessionStorage() {
        throw new Error('blocked');
      },
    });
    await expect(frontDeskFetch('/api/me')).rejects.toThrow('Credential storage unavailable');
    expect(storeFrontDeskToken('new-owner')).toBe(false);
    vi.stubGlobal('window', { sessionStorage: { getItem: () => null } });
    await expect(frontDeskFetch('/api/message')).rejects.toThrow('Credential storage unavailable');
    expect(request).not.toHaveBeenCalled();
  });
  it('carries the stored owner from first-run through settings, requests and files', async () => {
    const request = mockRequest();
    storeFrontDeskToken('synthetic-owner');
    for (const path of [
      '/api/me',
      '/api/setup',
      '/api/message',
      '/api/summary',
      '/api/outcomes/entry/files',
    ])
      await frontDeskFetch(path);
    expect(request).toHaveBeenCalledTimes(5);
    for (const [, init] of request.mock.calls) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-owner');
      expect(init).toMatchObject({
        mode: 'same-origin',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
      });
    }
  });
  it('normalizes Headers and tuples without losing content type, signal or body', async () => {
    const request = mockRequest();
    storeFrontDeskToken('owner');
    const controller = new AbortController();
    const body = new FormData();
    body.set('profile_id', 'test');
    await frontDeskFetch('/api/setup', {
      method: 'POST',
      headers: new Headers({ 'X-Trace': 'trace', authorization: 'Bearer other' }),
      body,
      signal: controller.signal,
      redirect: 'follow',
      mode: 'cors',
    });
    const init = request.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer owner');
    expect(new Headers(init.headers).get('x-trace')).toBe('trace');
    expect(new Headers(init.headers).has('content-type')).toBe(false);
    expect(init.body).toBe(body);
    expect(init.signal).toBe(controller.signal);
    const headers = new Headers(attachFrontDeskAuthHeaders([['Content-Type', 'application/json']]));
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer owner');
  });
  it('preserves cookie/loopback mode without inventing a bearer', async () => {
    const request = mockRequest();
    await frontDeskFetch('/api/me');
    expect(new Headers(request.mock.calls[0]![1]?.headers).has('authorization')).toBe(false);
  });
  it.each([
    '/api/me/avatar',
    '/api/setup/avatar-generation',
    '/api/services/operator',
    '/api/secrets/introduce',
    '/api/secrets/apply',
    '/api/oauth/begin',
    '/api/setup/first-run',
    '/api/invites/join',
    'https://evil.test/api/me',
    '//evil.test/api/me',
    '/api/me/../services/operator',
    '/api/me/%2e%2e/services/operator',
    '/api/me%2f../services/operator',
    '/login',
    '/api/me#fragment',
    '/api/me\\evil',
  ])('refuses %s before fetch', async (path) => {
    const request = mockRequest();
    storeFrontDeskToken('owner');
    expect(isFrontDeskMemberApiPath(path)).toBe(false);
    await expect(frontDeskFetch(path)).rejects.toThrow('Unsupported member API path');
    expect(request).not.toHaveBeenCalled();
  });
  it.each([401, 403])('keeps rejected bearer on %s without anonymous retry', async (status) => {
    const request = vi.fn(async () => new Response(null, { status }));
    vi.stubGlobal('fetch', request);
    storeFrontDeskToken('rejected');
    expect((await frontDeskFetch('/api/me')).status).toBe(status);
    expect(request).toHaveBeenCalledTimes(1);
    expect(getStoredFrontDeskToken()).toBe('rejected');
  });
  it('refuses late responses after replacement, logout, repeated same-token sign-in and abort', async () => {
    for (const change of [
      () => storeFrontDeskToken('new'),
      () => clearFrontDeskToken(),
      () => storeFrontDeskToken('old'),
    ]) {
      storeFrontDeskToken('old');
      let resolve!: (value: Response) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          () =>
            new Promise<Response>((r) => {
              resolve = r;
            })
        )
      );
      const pending = frontDeskFetch('/api/message');
      change();
      resolve(response());
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    }
    const controller = new AbortController();
    controller.abort();
    const request = mockRequest();
    await expect(frontDeskFetch('/api/me', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(request).not.toHaveBeenCalled();
  });
  it('fences a token change while JSON arrives', async () => {
    storeFrontDeskToken('old');
    let resolve!: (value: unknown) => void;
    const wire = response();
    vi.spyOn(wire, 'json').mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => wire)
    );
    const received = await frontDeskFetch('/api/message');
    const body = received.json();
    storeFrontDeskToken('new');
    resolve({ ok: true });
    await expect(body).rejects.toMatchObject({ name: 'AbortError' });
  });
});

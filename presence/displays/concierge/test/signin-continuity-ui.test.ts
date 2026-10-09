import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import {
  fireEvent,
  installFakeDom,
  type FakeElement,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import SignInPage from '../src/app/signin/page';
import FirstRunSetupPage from '../src/app/setup/first-run/page';
import { clearFrontDeskToken, storeFrontDeskToken } from '../src/lib/front-desk-auth-token';

vi.mock('../src/lib/use-concierge-i18n', () => ({
  useConciergeI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
vi.mock('../src/lib/i18n', () => ({ frontDeskText: (key: string) => key }));
vi.mock('../src/app/setup/sso-settings-form', () => ({
  SsoSettingsForm: () => createElement('div', { 'data-testid': 'sso-settings' }, 'SSO settings'),
}));

// All credentials and responses in this suite are inert fixtures. No request
// reaches a live grant, first-run service, external origin, or browser storage.
const TOKEN_KEY = 'front-desk.token';
const SIGNIN_TOKEN = 'synthetic-signin-token';
const ISSUED_TOKEN = 'synthetic-first-run-token';
const NEWER_TOKEN = 'synthetic-newer-token';
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const claim = () => ({
  ok: true,
  token: ISSUED_TOKEN,
  tenant_slug: 'fixture-tenant',
  member_id: 'fixture-owner',
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

type StorageMode =
  'working' | 'blocked' | 'write-throws' | 'write-noop' | 'clear-throws' | 'clear-noop';
let mode: StorageMode;
let values: Map<string, string>;
let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
let unmount: (() => void) | undefined;
let assign: ReturnType<typeof vi.fn>;
let storage: {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
};
beforeAll(async () => {
  dom = installFakeDom();
  client = await import('react-dom/client');
});
beforeEach(() => {
  mode = 'working';
  values = new Map();
  storage = {
    getItem: vi.fn((key: string) => {
      if (mode === 'blocked') throw new Error('Synthetic storage denied');
      return values.get(key) ?? null;
    }),
    setItem: vi.fn((key: string, value: string) => {
      if (mode === 'blocked' || mode === 'write-throws') throw new Error('Synthetic write denied');
      if (mode !== 'write-noop') values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      if (mode === 'blocked' || mode === 'clear-throws') throw new Error('Synthetic clear denied');
      if (mode !== 'clear-noop') values.delete(key);
    }),
  };
  dom.window.sessionStorage = storage;
  // Reset the module's fail-closed flag through its public recovery operation.
  expect(clearFrontDeskToken()).toBe(true);
  storage.removeItem.mockClear();
  assign = vi.fn();
  setLocation('/signin');
  dom.window.history = {
    replaceState: vi.fn((_state: unknown, _title: string, path: string) => setLocation(path)),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected synthetic request');
    }),
  );
});
afterEach(() => {
  unmount?.();
  vi.unstubAllGlobals();
});
afterAll(() => dom.restore());

function setLocation(path: string) {
  const url = new URL(path, 'https://concierge.example.test');
  dom.window.location = {
    href: url.href,
    hostname: url.hostname,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    origin: url.origin,
    assign,
  };
}
async function mount(page: 'signin' | 'first-run' = 'signin', path?: string) {
  setLocation(path ?? (page === 'signin' ? '/signin' : '/setup/first-run'));
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  unmount = () => {
    act(() => root.unmount());
    dom.document.body.removeChild(container);
    unmount = undefined;
  };
  await act(async () =>
    root.render(createElement(page === 'signin' ? SignInPage : FirstRunSetupPage)),
  );
  return container;
}
function element(container: FakeElement, selector: string): FakeElement {
  const found = container.querySelector(selector);
  if (!found) throw new Error('Missing element ' + selector);
  return found;
}
async function input(container: FakeElement, index: number, value: string) {
  const target = container.querySelectorAll('input')[index];
  if (!target) throw new Error('Missing input ' + index);
  await act(async () => {
    (target as unknown as { value: string }).value = value;
    fireEvent(target, 'input');
  });
}
async function click(container: FakeElement, selector = 'button', twice = false) {
  const target = element(container, selector);
  await act(async () => {
    fireEvent(target, 'click');
    if (twice) fireEvent(target, 'click');
  });
}
function serveFirstRun(response: Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST' ? response : json({ state: 'unclaimed' }),
    ),
  );
}
async function fillClaim(container: FakeElement) {
  await input(container, 0, 'synthetic-one-time-code');
  await input(container, 1, 'fixture-tenant');
  await input(container, 2, 'Fixture tenant');
  await input(container, 3, 'Fixture owner');
}
const posts = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST');
const invalidations = ['unmount', 'back', 'query', 'newer-auth', 'cleared-auth'] as const;
function invalidate(kind: (typeof invalidations)[number]) {
  if (kind === 'unmount') unmount?.();
  else if (kind === 'back') setLocation('/settings');
  else if (kind === 'query') window.location.search = '?next=%2Fmembers';
  else if (kind === 'newer-auth') expect(storeFrontDeskToken(NEWER_TOKEN)).toBe(true);
  else expect(clearFrontDeskToken()).toBe(true);
}

describe('explicit sign-in continuity', () => {
  it('keeps the existing credential on mount, then verifies and stores the trimmed token before returning', async () => {
    values.set(TOKEN_KEY, 'synthetic-existing-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ ok: true })),
    );
    const view = await mount(
      'signin',
      '/signin?next=' + encodeURIComponent('/settings?tab=profile#identity'),
    );
    expect(values.get(TOKEN_KEY)).toBe('synthetic-existing-token');
    expect(storage.removeItem).not.toHaveBeenCalled();
    await input(view, 0, '  ' + SIGNIN_TOKEN + '  ');
    await click(view);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      '/api/me',
      expect.objectContaining({
        headers: { Authorization: 'Bearer ' + SIGNIN_TOKEN },
        cache: 'no-store',
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(values.get(TOKEN_KEY)).toBe(SIGNIN_TOKEN);
    expect(storage.getItem).toHaveBeenCalledWith(TOKEN_KEY);
    expect(assign).toHaveBeenCalledExactlyOnceWith('/settings?tab=profile#identity');
  });

  it('accepts only one fetch from two synchronous clicks and blocks SSO while it is pending', async () => {
    const pending = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => pending.promise),
    );
    const view = await mount();
    await input(view, 0, SIGNIN_TOKEN);
    await click(view, 'button', true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(element(view, 'button').disabled).toBe(true);
    let prevented = false;
    await act(async () => {
      prevented = fireEvent(element(view, 'a'), 'click').defaultPrevented;
    });
    expect(prevented).toBe(true);
    expect(storage.removeItem).not.toHaveBeenCalled();
    await act(async () => pending.resolve(json({ ok: true })));
    expect(assign).toHaveBeenCalledExactlyOnceWith('/');
  });

  it.each(invalidations)(
    'does not store or navigate after %s invalidates a late successful body',
    async (kind) => {
      const body = deferred<unknown>();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, json: () => body.promise }) as Response),
      );
      const view = await mount();
      await input(view, 0, SIGNIN_TOKEN);
      await click(view);
      const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
      invalidate(kind);
      if (kind === 'unmount') expect(signal.aborted).toBe(true);
      storage.setItem.mockClear();
      await act(async () => body.resolve({ ok: true }));
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(values.get(TOKEN_KEY)).toBe(kind === 'newer-auth' ? NEWER_TOKEN : undefined);
      expect(assign).not.toHaveBeenCalled();
    },
  );

  it.each(['blocked', 'write-throws', 'write-noop'] as const)(
    'stays on sign-in and explains the failure with %s storage',
    async (failure) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => json({ ok: true })),
      );
      const view = await mount();
      await input(view, 0, SIGNIN_TOKEN);
      mode = failure;
      await click(view);
      expect(assign).not.toHaveBeenCalled();
      expect(view.textContent).toContain('signin_storage_error');
      expect(element(view, 'button').disabled).toBe(false);
      expect(values.has(TOKEN_KEY)).toBe(false);
    },
  );

  it('retains the rejected credential and allows an explicit retry without a remount', async () => {
    values.set(TOKEN_KEY, 'synthetic-existing-token');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ ok: false }, 401))
        .mockResolvedValueOnce(json({ ok: true })),
    );
    const view = await mount();
    await input(view, 0, SIGNIN_TOKEN);
    await click(view);
    expect(view.textContent).toContain('signin_error');
    expect(values.get(TOKEN_KEY)).toBe('synthetic-existing-token');
    expect(assign).not.toHaveBeenCalled();
    await click(view);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(values.get(TOKEN_KEY)).toBe(SIGNIN_TOKEN);
    expect(assign).toHaveBeenCalledExactlyOnceWith('/');
  });

  it('intentionally clears the credential only when following the safe SSO link', async () => {
    values.set(TOKEN_KEY, 'synthetic-existing-token');
    const next = '/settings?tab=services#setup';
    const view = await mount('signin', '/signin?next=' + encodeURIComponent(next));
    const link = element(view, 'a');
    expect(link.getAttribute('href')).toBe('/login?next=' + encodeURIComponent(next));
    let prevented = true;
    await act(async () => {
      prevented = fireEvent(link, 'click').defaultPrevented;
    });
    expect(prevented).toBe(false);
    expect(storage.removeItem).toHaveBeenCalledExactlyOnceWith(TOKEN_KEY);
    expect(values.has(TOKEN_KEY)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'clear-throws', 'clear-noop'] as const)(
    'blocks SSO navigation if %s storage cannot clear the rejected bearer',
    async (failure) => {
      values.set(TOKEN_KEY, 'synthetic-rejected-token');
      const view = await mount();
      mode = failure;
      let prevented = false;
      await act(async () => {
        prevented = fireEvent(element(view, 'a'), 'click').defaultPrevented;
      });
      expect(prevented).toBe(true);
      expect(view.textContent).toContain('signin_storage_error');
      expect(values.get(TOKEN_KEY)).toBe('synthetic-rejected-token');
      expect(fetch).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
    },
  );

  it.each([
    'https://outside.example.test/private',
    '//outside.example.test/private',
    '/signin',
    '/signin?next=%2Fsettings',
    '/signin/',
    '/%73ignin',
  ])('falls back to home for unsafe or self-loop next %s', async (next) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ ok: true })),
    );
    const view = await mount('signin', '/signin?next=' + encodeURIComponent(next));
    expect(element(view, 'a').getAttribute('href')).toBe('/login');
    await input(view, 0, SIGNIN_TOKEN);
    await click(view);
    expect(assign).toHaveBeenCalledExactlyOnceWith('/');
  });
});

describe('first-run claim continuity', () => {
  it('stores the issued token before revealing SSO setup and Continue', async () => {
    serveFirstRun(json(claim()));
    const view = await mount('first-run');
    await fillClaim(view);
    await click(view);
    expect(posts()).toHaveLength(1);
    expect(posts()[0][1]).toMatchObject({
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(String(posts()[0][1]!.body))).toEqual({
      code: 'synthetic-one-time-code',
      tenant_slug: 'fixture-tenant',
      tenant_display_name: 'Fixture tenant',
      display_name: 'Fixture owner',
    });
    expect(values.get(TOKEN_KEY)).toBe(ISSUED_TOKEN);
    expect(view.textContent).toContain(ISSUED_TOKEN);
    expect(view.querySelector('[data-testid="sso-settings"]')).not.toBeNull();
    expect(element(view, 'a').getAttribute('href')).toBe('/');
    expect(view.textContent).toContain('first_run_finish');
    expect(assign).not.toHaveBeenCalled();
  });

  it('claims only once when the claim button is clicked twice synchronously', async () => {
    const pending = deferred<Response>();
    serveFirstRun(pending.promise);
    const view = await mount('first-run');
    await fillClaim(view);
    await click(view, 'button', true);
    expect(posts()).toHaveLength(1);
    expect(element(view, 'button').disabled).toBe(true);
    await act(async () => pending.resolve(json(claim())));
    expect(values.get(TOKEN_KEY)).toBe(ISSUED_TOKEN);
    expect(posts()).toHaveLength(1);
  });

  it.each(['blocked', 'write-throws', 'write-noop'] as const)(
    'preserves the issued token under %s storage and retries storage without another claim',
    async (failure) => {
      serveFirstRun(json(claim()));
      const view = await mount('first-run');
      await fillClaim(view);
      mode = failure;
      await click(view);
      expect(posts()).toHaveLength(1);
      expect(view.textContent).toContain(ISSUED_TOKEN);
      expect(view.textContent).toContain('signin_storage_error');
      expect(view.textContent).not.toContain('first_run_finish');
      expect(view.querySelector('a')).toBeNull();
      expect(view.querySelector('[data-testid="sso-settings"]')).toBeNull();
      const requestsBeforeRetry = vi.mocked(fetch).mock.calls.length;
      await click(view);
      expect(view.textContent).toContain(ISSUED_TOKEN);
      expect(view.querySelector('a')).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(requestsBeforeRetry);
      mode = 'working';
      await click(view);
      expect(fetch).toHaveBeenCalledTimes(requestsBeforeRetry);
      expect(posts()).toHaveLength(1);
      expect(values.get(TOKEN_KEY)).toBe(ISSUED_TOKEN);
      expect(view.textContent).not.toContain('signin_storage_error');
      expect(view.querySelector('[data-testid="sso-settings"]')).not.toBeNull();
      expect(element(view, 'a').getAttribute('href')).toBe('/');
    },
  );

  it.each(invalidations)(
    'does not store or enable continuation after %s invalidates a late claim body',
    async (kind) => {
      const body = deferred<unknown>();
      serveFirstRun({ ok: true, json: () => body.promise } as Response);
      const view = await mount('first-run');
      await fillClaim(view);
      await click(view);
      const signal = posts()[0][1]!.signal!;
      invalidate(kind);
      if (kind === 'unmount') expect(signal.aborted).toBe(true);
      storage.setItem.mockClear();
      await act(async () => body.resolve(claim()));
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(values.get(TOKEN_KEY)).toBe(kind === 'newer-auth' ? NEWER_TOKEN : undefined);
      expect(assign).not.toHaveBeenCalled();
      expect(view.querySelector('[data-testid="sso-settings"]')).toBeNull();
      expect(view.querySelector('a')).toBeNull();
      if (kind !== 'unmount') expect(view.textContent).toContain(ISSUED_TOKEN);
      expect(posts()).toHaveLength(1);
    },
  );

  it('reads the one-time fragment into the form and removes it before submitting', async () => {
    serveFirstRun(json(claim()));
    const view = await mount('first-run', '/setup/first-run#code=synthetic-fragment-code');
    expect(window.history.replaceState).toHaveBeenCalledExactlyOnceWith(
      null,
      '',
      '/setup/first-run',
    );
    expect(window.location.hash).toBe('');
    expect((element(view, 'input') as unknown as { value: string }).value).toBe(
      'synthetic-fragment-code',
    );
    expect(posts()).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/setup/first-run');
  });
});

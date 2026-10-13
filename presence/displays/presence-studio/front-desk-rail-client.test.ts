import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { safeReadFile } from '@agent/core/secure-io';
import { FRONT_DESK_MENU, resolveFrontDeskMenu } from '@agent/core/front-desk-nav';

const source = String(
  safeReadFile('presence/displays/presence-studio/static/front-desk-rail.js')
).replace("import { renderA2UI } from '/shared-ui/kyberion-ui.js';", '');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
interface RailItem {
  id: string;
  active?: boolean;
  group_label: string;
  icon: string;
  href: string;
}
interface RailRender {
  components: Array<{ props: { items: RailItem[]; footer_items?: RailItem[] } }>;
  options: { onAction(action: { id: string; payload: { value: string } }): void };
}
function harness(pathname: string, fetchOverride?: (url: string) => Promise<unknown>) {
  const rendered: RailRender[] = [];
  const location = { pathname, search: '', href: 'http://localhost' + pathname, reload: vi.fn() };
  let tenant = 'alpha';
  const menu = resolveFrontDeskMenu({
    currentSurface: 'presence-studio',
    role: 'owner',
    availableSurfaces: {
      'chronos-mirror-v2': 'http://localhost:3000',
      'operator-surface': 'http://localhost:3331',
    },
  }).map((item) => ({ ...item, label: item.id, sublabel: item.id, group_label: item.group_key }));
  const me = (slug = 'alpha') => ({
    ok: true,
    viewing: { tenant_slug: slug, role: 'owner', display_name: slug },
    tenants: [],
    can_switch: false,
  });
  const fetch = vi.fn(async (url: string, _options?: { method?: string; signal?: AbortSignal }) => {
    if (fetchOverride) {
      const override = await fetchOverride(url);
      if (override) return override;
    }
    return {
      ok: true,
      status: 200,
      json: async () =>
        url.includes('/api/me')
          ? me(new URL(url, 'http://localhost').searchParams.get('tenant') ?? 'alpha')
          : url.includes('/api/front-desk/nav')
            ? { ok: true, items: menu, role_labels: { owner: 'Owner' } }
            : { ok: true, messages: {} },
    };
  });
  const window = {
    location,
    setTimeout,
    clearTimeout,
    AbortController,
    localStorage: {
      getItem: () => tenant,
      setItem: (_key: string, value: string) => {
        tenant = value;
      },
    },
    KyberionPrefs: {
      locale: () => 'en',
      tenant: () => tenant,
      setTenant: (value: string) => {
        tenant = value;
      },
      scopedUrl: (href: string) => {
        const url = new URL(href, 'http://localhost');
        url.searchParams.set('tenant', tenant);
        return url.href;
      },
    },
  };
  runInNewContext(source, {
    window,
    document: { querySelector: () => null },
    fetch,
    URL,
    URLSearchParams,
    renderA2UI: (
      _host: unknown,
      components: RailRender['components'],
      options: RailRender['options']
    ) => {
      rendered.push({ components, options });
    },
  });
  const client = window as typeof window & {
    FrontDeskRail: {
      mount(host: object, options: { current: string }): Promise<unknown>;
      ready: Promise<unknown>;
      retry(): Promise<unknown>;
      subscribe(listener: (state: { phase: string; reason?: string }) => void): () => void;
    };
  };
  return {
    window,
    rendered,
    menu,
    me,
    fetch,
    tenant: () => tenant,
    rail: client.FrontDeskRail,
    mount: () => client.FrontDeskRail.mount({}, { current: 'home' }),
  };
}
describe('shipped grouped front-desk rail client', () => {
  it.each([
    ['/work', 'workspace'],
    ['/first-job', 'first-job'],
    ['/help/owner', 'help'],
  ])('marks %s from the route rather than a stale home hint', async (path, id) => {
    const h = harness(path);
    await h.mount();
    const items = h.rendered.at(-1)!.components[0].props.items;
    expect(items).toHaveLength(FRONT_DESK_MENU.length);
    expect(items.filter((item) => item.active).map((item) => item.id)).toEqual([id]);
    expect(
      items.every((item) => item.group_label && item.icon && item.href.includes('tenant=alpha'))
    ).toBe(true);
    expect(items.find((item) => item.id === 'missions').href).toContain('section=missions');
  });
  it('fails closed for denied and unknown allowed values, without duplicate help', async () => {
    const h = harness('/work');
    h.menu[0].allowed = false;
    (h.menu[1] as { allowed?: boolean }).allowed = undefined;
    await h.mount();
    const items = h.rendered.at(-1)!.components[0].props.items;
    expect(items.some((item) => item.id === 'home' || item.id === 'ask')).toBe(false);
    expect(items.filter((item) => item.id === 'help')).toHaveLength(1);
    expect(h.rendered.at(-1)!.components[0].props.footer_items).toBeUndefined();
  });
  it('ignores an interrupted older mount', async () => {
    const old = deferred<unknown>();
    let count = 0;
    const h = harness('/first-job', async (url) =>
      url.includes('/api/me') && ++count === 1 ? old.promise : undefined
    );
    const first = h.mount();
    await h.mount();
    old.resolve({ ok: true, status: 200, json: async () => h.me('old') });
    await first;
    expect(h.tenant()).toBe('alpha');
    expect(h.rendered).toHaveLength(1);
  });
  it('only completes the latest repeated tenant switch', async () => {
    const older = deferred<unknown>();
    const h = harness('/work', async (url) =>
      url.includes('tenant=beta') ? older.promise : undefined
    );
    await h.mount();
    const action = h.rendered.at(-1)!.options.onAction;
    action({ id: 'tenant.switch', payload: { value: 'beta' } });
    action({ id: 'tenant.switch', payload: { value: 'gamma' } });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    older.resolve({ ok: true, status: 200, json: async () => h.me('beta') });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.tenant()).toBe('gamma');
    expect(h.window.location.reload).toHaveBeenCalledTimes(1);
  });
});

describe('bounded front-desk shell startup', () => {
  afterEach(() => vi.useRealTimers());
  it('shows a bounded failure without releasing ready for a stalled identity read', async () => {
    vi.useFakeTimers();
    const h = harness('/ask', async (url) =>
      url.includes('/api/me') ? new Promise(() => {}) : undefined
    );
    const states: Array<{ phase: string; reason?: string }> = [];
    h.rail.subscribe((state) => states.push(state));
    const attempt = h.mount();
    const ready = vi.fn();
    h.rail.ready.then(ready);
    await vi.advanceTimersByTimeAsync(20000);
    await attempt;
    expect(states.at(-1)).toMatchObject({ phase: 'blocked', reason: 'unavailable' });
    expect(ready).not.toHaveBeenCalled();
    expect(h.fetch.mock.calls.some(([url]) => url.includes('/api/front-desk/nav'))).toBe(false);
  });
  it.each([401, 403])('blocks status %s before trying to read its error body', async (status) => {
    const json = vi.fn(() => new Promise(() => {}));
    const h = harness('/ask', async (url) =>
      url.includes('/api/me') ? { ok: false, status, json } : undefined
    );
    const states: Array<{ phase: string; reason?: string }> = [];
    h.rail.subscribe((state) => states.push(state));
    await h.mount();
    expect(states.at(-1)).toMatchObject({
      phase: 'blocked',
      reason: status === 401 ? 'authentication' : 'permission',
    });
    expect(json).not.toHaveBeenCalled();
    expect(h.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(h.rendered).toHaveLength(0);
  });
  it('bounds a stalled successful response body', async () => {
    vi.useFakeTimers();
    const h = harness('/progress', async (url) =>
      url.includes('/api/front-desk/nav')
        ? { ok: true, status: 200, json: () => new Promise(() => {}) }
        : undefined
    );
    const states: Array<{ phase: string; reason?: string }> = [];
    h.rail.subscribe((state) => states.push(state));
    const attempt = h.mount();
    await vi.advanceTimersByTimeAsync(20000);
    await attempt;
    expect(states.at(-1)?.phase).toBe('blocked');
    expect(h.rendered).toHaveLength(0);
  });
  it('clears a stale stored tenant when the successful identity has no viewing tenant', async () => {
    const h = harness('/ask', async (url) =>
      url.includes('/api/me')
        ? {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, viewing: null, tenants: [], can_switch: false }),
          }
        : undefined
    );
    await h.mount();
    expect(h.tenant()).toBe(null);
  });
});

describe('front-desk shell recovery races', () => {
  afterEach(() => vi.useRealTimers());
  it('keeps the same ready waiter across retry and ignores late timed-out identity', async () => {
    vi.useFakeTimers();
    const old = deferred<unknown>();
    let count = 0;
    const h = harness('/ask', async (url) =>
      url.includes('/api/me') && ++count === 1 ? old.promise : undefined
    );
    const first = h.mount();
    const ready = h.rail.ready;
    const resumed = vi.fn();
    ready.then(resumed);
    await vi.advanceTimersByTimeAsync(20000);
    await first;
    await h.rail.retry();
    await ready;
    expect(h.rail.ready).toBe(ready);
    expect(resumed).toHaveBeenCalledTimes(1);
    old.resolve({ ok: true, status: 200, json: async () => h.me('old') });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.tenant()).toBe('alpha');
    expect(h.rendered).toHaveLength(1);
  });
  it('single-flights repeated retries after a temporary nav failure', async () => {
    let count = 0;
    const nav = deferred<unknown>();
    const h = harness('/ask', async (url) => {
      if (!url.includes('/api/front-desk/nav')) return;
      count++;
      return count === 1 ? { ok: false, status: 503, json: async () => ({}) } : nav.promise;
    });
    await h.mount();
    const first = h.rail.retry();
    const second = h.rail.retry();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(count).toBe(2);
    nav.resolve({ ok: true, status: 200, json: async () => ({ ok: true, items: [] }) });
    await Promise.all([first, second]);
    await h.rail.ready;
    expect(
      h.fetch.mock.calls.every((call) => !(call[1] as { method?: string } | undefined)?.method)
    ).toBe(true);
  });
  it('never releases an abandoned mount when a new mount succeeds', async () => {
    const old = deferred<unknown>();
    let count = 0;
    const h = harness('/ask', async (url) =>
      url.includes('/api/me') && ++count === 1 ? old.promise : undefined
    );
    const first = h.mount();
    const resumed = vi.fn();
    h.rail.ready.then(resumed);
    await h.mount();
    old.resolve({ ok: true, status: 200, json: async () => h.me('old') });
    await first;
    expect(resumed).not.toHaveBeenCalled();
    expect(h.tenant()).toBe('alpha');
    expect(h.rendered).toHaveLength(1);
  });
  it('rejects an identity completion for a changed URL scope, then retries that selection', async () => {
    const old = deferred<unknown>();
    let count = 0;
    const states: Array<{ phase: string; reason?: string }> = [];
    const h = harness('/ask', async (url) =>
      url.includes('/api/me') && ++count === 1 ? old.promise : undefined
    );
    h.rail.subscribe((s) => states.push(s));
    const first = h.mount();
    h.window.location.search = '?tenant=beta&projectId=new';
    old.resolve({ ok: true, status: 200, json: async () => h.me('alpha') });
    await first;
    expect(states.at(-1)).toMatchObject({ phase: 'blocked', reason: 'changed' });
    expect(h.rendered).toHaveLength(0);
    await h.rail.retry();
    expect(h.tenant()).toBe('beta');
    expect(h.rendered).toHaveLength(1);
  });
  it('bounds optional renderer messages and resumes with its built-in fallback', async () => {
    vi.useFakeTimers();
    const h = harness('/ask', async (url) =>
      url.includes('/shared-ui/messages/')
        ? { ok: true, status: 200, json: () => new Promise(() => {}) }
        : undefined
    );
    const attempt = h.mount();
    await vi.advanceTimersByTimeAsync(20000);
    await attempt;
    await h.rail.ready;
    expect(h.rendered).toHaveLength(1);
  });
  it('does not draw an older mount after a delayed shared message bundle', async () => {
    const messages = deferred<unknown>();
    const h = harness('/ask', async (url) =>
      url.includes('/shared-ui/messages/') ? messages.promise : undefined
    );
    const first = h.mount();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    const second = h.mount();
    messages.resolve({ ok: true, status: 200, json: async () => ({ ok: true, messages: {} }) });
    await Promise.all([first, second]);
    expect(h.rendered).toHaveLength(1);
  });
  it.each(['me-malformed', 'nav-malformed', 'network', 'invalid-json'])(
    'blocks %s without releasing readiness',
    async (kind) => {
      const h = harness('/ask', async (url) => {
        if (kind === 'nav-malformed' && url.includes('/api/front-desk/nav'))
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        if (!url.includes('/api/me')) return;
        if (kind === 'network') throw Error('offline');
        if (kind === 'invalid-json')
          return {
            ok: true,
            status: 200,
            json: async () => {
              throw Error('not JSON');
            },
          };
        if (kind === 'me-malformed')
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
      });
      const states: Array<{ phase: string; reason?: string }> = [];
      h.rail.subscribe((s) => states.push(s));
      await h.mount();
      expect(states.at(-1)?.phase).toBe('blocked');
      expect(h.rendered).toHaveLength(0);
    }
  );
});

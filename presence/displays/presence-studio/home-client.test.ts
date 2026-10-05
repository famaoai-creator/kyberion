import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { safeReadFile } from '@agent/core/secure-io';

/** Executes the shipped browser client against a DOM/event double, not visual layout. */
class Element {
  children: Element[] = [];
  attributes: Record<string, string> = {};
  listeners: Record<string, () => unknown> = {};
  private text = '';
  value = '';
  className = '';
  hidden = false;
  disabled = false;
  open = false;
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join(' ');
  }
  appendChild(child: Element) {
    this.children.push(child);
    return child;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  addEventListener(name: string, fn: () => unknown) {
    this.listeners[name] = fn;
  }
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
function work(id = 'a', status = 'running') {
  return {
    id: 'conversation:' + id,
    source: 'conversation',
    source_id: id,
    title: 'Work ' + id,
    status,
    status_key: 'front_desk:work_home_status_' + status,
    next_step_key: 'front_desk:work_home_next_inspect_status',
    unknowns: status === 'unknown' ? ['execution_state_unknown'] : [],
    links: [{ kind: 'conversation', target_id: id, href: '/ask?request=' + id + '&tenant=alpha' }],
  };
}
function payload(items = [work()], coverage = 'supported_sources_ready') {
  return {
    ok: true,
    work_home: {
      version: 1,
      scope_id: 'scope-alpha',
      observed_at: '2026-10-05T10:00:00Z',
      coverage,
      sources: [
        {
          id: 'conversation',
          state: coverage === 'partial' ? 'unavailable' : 'available',
          total: items.length,
          shown: items.length,
        },
      ],
      items,
      attention: items.filter((x) => x.status === 'unknown'),
      updates: [],
      counts: {
        all: items.length,
        attention: items.filter((x) => x.status === 'unknown').length,
        active: items.length,
        answered: 0,
        verified: 0,
      },
    },
  };
}
function harness(
  options: {
    home?: () => Promise<unknown>;
    storage?: Map<string, string>;
    storageFails?: boolean;
    vocabularyFails?: () => boolean;
  } = {}
) {
  const ids = [
    'ask-form',
    'ask-input',
    'home-next',
    'home-error',
    'home-metrics',
    'home-sources',
    'decide-body',
    'progress-body',
    'decide-count',
    'progress-summary',
    'home-detail-mode',
    'home-refresh',
  ];
  const elements = new Map(ids.map((id) => [id, new Element()]));
  elements.get('home-error')!.textContent = 'server-rendered failure';
  elements.get('home-error')!.hidden = true;
  const storage = options.storage ?? new Map<string, string>();
  let scope = 'alpha';
  const fetch = vi.fn(async (url: string, init?: { method?: string }) => ({
    ok: true,
    json: async () =>
      url.startsWith('/api/home-vocabulary')
        ? options.vocabularyFails?.()
          ? Promise.reject(new Error('copy failed'))
          : { ok: true, texts: new Proxy({}, { get: (_t, k) => String(k) }) }
        : await (options.home?.() ?? Promise.resolve(payload())),
  }));
  const location = { href: 'https://example.test/?tenant=alpha', origin: 'https://example.test' };
  const window = {
    location,
    KyberionPrefs: {
      locale: () => 'en',
      scopedUrl: (path: string) => path + (path.includes('?') ? '&' : '?') + 'tenant=' + scope,
    },
    FrontDeskRail: {
      ready: Promise.resolve(),
      render: (host: Element, components: unknown) => {
        host.textContent = JSON.stringify(components);
      },
    },
    localStorage: {
      getItem: (key: string) => {
        if (options.storageFails) throw Error('blocked');
        return storage.get(key) ?? null;
      },
      setItem: (key: string, val: string) => {
        if (options.storageFails) throw Error('blocked');
        storage.set(key, val);
      },
    },
    addEventListener: vi.fn(),
    KyberionHome: undefined as
      undefined | { mount: () => Promise<void>; refresh: () => Promise<void> },
  };
  const document = {
    documentElement: { getAttribute: () => 'en' },
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelector: () => null,
    createElement: () => new Element(),
    createElementNS: () => new Element(),
  };
  runInNewContext(
    String(safeReadFile('presence/displays/presence-studio/static/home.js', { encoding: 'utf8' })),
    { window, document, fetch, URL, URLSearchParams, Date, Number }
  );
  return {
    elements,
    fetch,
    storage,
    mount: () => window.KyberionHome!.mount(),
    refresh: () => window.KyberionHome!.refresh(),
    scope: (value: string) => {
      scope = value;
    },
  };
}
function descendants(node: Element): Element[] {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}
describe('work home browser workflow', () => {
  it('shows multiple work items and attention together without any mutation requests', async () => {
    const h = harness({
      home: async () => payload([work('a'), work('b', 'unknown'), work('c', 'answered')]),
    });
    await h.mount();
    expect(h.elements.get('progress-body')!.children).toHaveLength(3);
    expect(h.elements.get('decide-body')!.children).toHaveLength(1);
    expect(h.elements.get('decide-body')!.textContent).toContain('work_home_status_unknown');
    expect(h.fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true
    );
    const links = descendants(h.elements.get('progress-body')!).filter((e) => e.attributes.href);
    expect(links[0].attributes.href).toBe('/ask?request=a&tenant=alpha');
  });
  it('never shows empty or all-clear for an unavailable source', async () => {
    const h = harness({ home: async () => payload([], 'partial') });
    await h.mount();
    expect(h.elements.get('home-next')!.textContent).toContain('work_home_partial');
    expect(h.elements.get('decide-body')!.textContent).toContain('work_home_attention_unknown');
  });
  it('quiet mode preserves unknowns, and detail preference persists only an enum', async () => {
    const storage = new Map<string, string>();
    const h = harness({ storage, home: async () => payload([work('b', 'unknown')]) });
    await h.mount();
    expect(h.elements.get('progress-body')!.textContent).toContain(
      'unknown_execution_state_unknown'
    );
    const mode = h.elements.get('home-detail-mode')!;
    mode.value = 'detailed';
    mode.listeners.change();
    expect([...storage.entries()]).toEqual([['kyberion.work-home.detail.scope-alpha', 'detailed']]);
    const reloaded = harness({ storage });
    await reloaded.mount();
    expect(reloaded.elements.get('home-detail-mode')!.value).toBe('detailed');
  });
  it('works with storage denied and does not subscribe to anything', async () => {
    const h = harness({ storageFails: true });
    await h.mount();
    const mode = h.elements.get('home-detail-mode')!;
    mode.value = 'detailed';
    mode.listeners.change();
    expect(h.elements.get('progress-body')!.children).toHaveLength(1);
    expect(h.fetch.mock.calls.every(([url]) => url.startsWith('/api/home'))).toBe(true);
  });
  it('discards an old-scope response and fetches the current scope', async () => {
    const first = deferred<unknown>();
    let calls = 0;
    const h = harness({
      home: () => (++calls === 1 ? first.promise : Promise.resolve(payload([work('new')]))),
    });
    const loading = h.mount();
    await flush();
    h.scope('beta');
    first.resolve(payload([work('old')]));
    await loading;
    expect(h.elements.get('progress-body')!.textContent).not.toContain('Work old');
    expect(h.elements.get('progress-body')!.textContent).toContain('Work new');
    expect(h.fetch.mock.calls.some(([url]) => url === '/api/home?tenant=beta')).toBe(true);
  });
  it('discards an older refresh and keeps the newest response', async () => {
    const old = deferred<unknown>();
    let calls = 0;
    const h = harness({
      home: () => (++calls === 2 ? old.promise : Promise.resolve(payload([work(String(calls))]))),
    });
    await h.mount();
    const pending = h.refresh();
    await flush();
    await h.refresh();
    old.resolve(payload([work('stale')]));
    await pending;
    expect(h.elements.get('progress-body')!.textContent).toContain('Work 3');
    expect(h.elements.get('progress-body')!.textContent).not.toContain('stale');
  });
  it('drops unsafe or executing links rather than navigating them', async () => {
    const row = work();
    row.links = [
      { kind: 'conversation', target_id: 'a', href: '/ask?send=1&ask=again' },
      { kind: 'conversation', target_id: 'b', href: 'https://evil.test' },
    ];
    const h = harness({ home: async () => payload([row]) });
    await h.mount();
    expect(
      descendants(h.elements.get('progress-body')!).filter((e) => e.attributes.href)
    ).toHaveLength(0);
  });
  it('failed refresh clears stale work and shows uncertainty', async () => {
    let fail = false;
    const h = harness({
      home: async () => {
        if (fail) throw Error('offline');
        return payload();
      },
    });
    await h.mount();
    fail = true;
    await h.refresh();
    expect(h.elements.get('progress-body')!.children).toHaveLength(0);
    expect(h.elements.get('home-error')!.hidden).toBe(false);
    expect(h.elements.get('decide-count')!.hidden).toBe(true);
    expect(h.elements.get('progress-summary')!.textContent).toBe('');
  });
});

it('keeps server-rendered error and retry available when vocabulary cannot load', async () => {
  let failed = true;
  const h = harness({ vocabularyFails: () => failed });
  await h.mount();
  expect(h.elements.get('home-error')!.hidden).toBe(false);
  expect(h.elements.get('home-error')!.textContent).toBe('server-rendered failure');
  failed = false;
  await h.elements.get('home-refresh')!.listeners.click();
  expect(h.elements.get('progress-body')!.children).toHaveLength(1);
  expect(h.elements.get('home-error')!.hidden).toBe(true);
});

it('shows old and pending version uncertainty in quiet mode and keeps valid artifact links', async () => {
  const old = {
    ...work('old', 'work_completed'),
    artifact: { currentness: 'older_verified', revision: 1 },
    links: [{ kind: 'artifact', target_id: 'old', href: '/api/artifacts/old' }],
  };
  const pending = {
    ...work('new', 'unknown'),
    artifact: { currentness: 'requested_unknown', revision: 2 },
    unknowns: ['version_unknown', 'execution_state_unknown'],
  };
  const h = harness({ home: async () => payload([old, pending]) });
  await h.mount();
  expect(h.elements.get('home-detail-mode')!.value).toBe('quiet');
  expect(h.elements.get('progress-body')!.textContent).toContain(
    'work_home_version_older_verified'
  );
  expect(h.elements.get('progress-body')!.textContent).toContain(
    'work_home_version_requested_unknown'
  );
  expect(
    descendants(h.elements.get('progress-body')!).some(
      (e) => e.attributes.href === '/api/artifacts/old'
    )
  ).toBe(true);
});

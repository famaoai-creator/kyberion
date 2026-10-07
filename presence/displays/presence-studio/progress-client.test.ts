import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { safeReadFile } from '@agent/core/secure-io';

type MockEvent = {
  target: Element;
  preventDefault: () => void;
  stopPropagation: () => void;
  [key: string]: unknown;
};
type FetchInput = { method?: string; body?: string; [key: string]: unknown };
type MockResponse = ReturnType<typeof response>;
// An intentionally small DOM double: checks event wiring and rendered contracts,
// not layout or browser accessibility behavior. No browser/service/network runs.
class Element {
  children: Element[] = [];
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<(event: MockEvent) => void>> = {};
  hidden = false;
  disabled = false;
  className = '';
  textContent = '';
  value = '';
  href = '';
  private html = '';
  action?: string;
  tag = 'div';
  classList = { add: vi.fn(), remove: vi.fn() };
  set innerHTML(value: string) {
    this.html = value;
    this.children = [];
    for (const match of value.matchAll(/<(button|a)[^>]*data-action="([^"]+)"[^>]*>/g)) {
      const child = new Element();
      child.tag = match[1];
      child.action = match[2];
      this.children.push(child);
    }
  }
  get innerHTML() {
    return this.html;
  }
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }
  getAttribute(key: string) {
    return this.attributes[key] || null;
  }
  appendChild(child: Element) {
    this.children.push(child);
    return child;
  }
  addEventListener(type: string, listener: (event: MockEvent) => void) {
    (this.listeners[type] ||= []).push(listener);
  }
  querySelectorAll(selector: string): Element[] {
    const matches = (child: Element) =>
      selector === 'button'
        ? child.tag === 'button'
        : selector === '[data-notice-text]'
          ? child.attributes['data-notice-text'] === 'true'
          : selector === '.progress-revise-form'
            ? child.className === 'progress-revise-form'
            : selector.match(/^\[data-action="(.*)"\]$/)?.[1] === child.action;
    return this.children.flatMap((child) => [
      ...(matches(child) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] || null;
  }
  closest(selector: string) {
    return selector === '[data-action]' && this.action ? this : null;
  }
  fire(type = 'click', extra: Record<string, unknown> = {}) {
    if (this.disabled && type === 'click') return;
    for (const listener of this.listeners[type] || [])
      listener({ target: this, preventDefault() {}, stopPropagation() {}, ...extra });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
const texts: Record<string, string> = {
  'front_desk:progress_history': 'History',
  'front_desk:progress_status_released': 'Released',
  'front_desk:progress_recovery': 'Discuss next steps',
  'front_desk:progress_load_failed': 'Could not load progress. Try again.',
  'front_desk:progress_action_failed': 'Decision outcome uncertain. Refresh before retry.',
  'front_desk:progress_storage_required': 'Allow session storage before recording a decision.',
  'front_desk:progress_scope_required': 'Decision scope could not be verified. Refresh.',
  'front_desk:progress_item_unavailable':
    'This work item is unavailable. Refresh or choose another item.',
  'front_desk:progress_request_pending': 'No tracked work is linked yet.',
  'front_desk:progress_refresh': 'Refresh',
  'front_desk:progress_phase_estimate': 'Phase estimate',
  'front_desk:progress_ask_about': 'About {title}',
  'front_desk:action_receive': 'Receive',
  'front_desk:action_open': 'Open',
  'front_desk:action_revise': 'Ask for changes',
  'front_desk:progress_action_note': 'Send a note',
  'front_desk:progress_open_mirror': 'Watch the screen',
  'front_desk:tag_in_progress': 'In progress',
  'front_desk:tag_delivered': 'Delivered',
  'ui:status_completed': 'Completed',
  'ui:status_failed': 'Failed',
  'concierge:home.status.accepted': 'Accepted',
  'concierge:home.status.rejected': 'Sent back',
  'concierge:home.status.changes_requested': 'Changes requested',
};
const detail = (title: string) => ({ ok: true, item: { requested: title, now: title, log: [] } });
const response = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 403,
  json: async () => body,
});
const emptyPayload = () => ({
  ok: true,
  viewer_scope_id: 'principal-alpha' as string | undefined,
  counts: { active: 0, delivered: 0, done: 0 },
  active: [] as Array<Record<string, unknown>>,
  delivered: [] as Array<Record<string, unknown>>,
  done: [] as Array<Record<string, unknown>>,
  mirror_href: 'https://screen.example.test/computer/',
});

function harness(
  options: {
    search?: string;
    tenant?: string;
    storage?: Map<string, string>;
    storageAvailable?: boolean;
    hash?: string;
    ready?: Promise<unknown>;
    page?: 'home' | 'progress';
    fetcher?: (path: string, options?: FetchInput) => Promise<MockResponse>;
  } = {}
) {
  const ids = [
    'filter-active',
    'filter-delivered',
    'filter-done',
    'progress-list',
    'progress-empty',
    'progress-detail',
    'delivered-header',
    'delivered-title',
    'delivered-waiting',
    'progress-notice',
    'wi-start',
    'home-next',
    'home-metrics',
    'decide-more',
    'decide-count',
    'decide-body',
    'progress-summary',
    'progress-more',
    'progress-body',
    'ask-form',
    'ask-input',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  const noticeText = new Element();
  noticeText.setAttribute('data-notice-text', 'true');
  const refresh = new Element();
  refresh.tag = 'button';
  elements['progress-notice'].appendChild(noticeText);
  elements['progress-notice'].appendChild(refresh);
  Object.entries(texts).forEach(([key, value]) =>
    elements['progress-notice'].setAttribute('data-' + key.replace('front_desk:', ''), value)
  );
  let location = new URL(
    'https://studio.example.test/' +
      (options.page || 'progress') +
      (options.search || '') +
      (options.hash || '')
  );
  const listeners: Record<string, () => void> = {};
  const storage = options.storage || new Map<string, string>();
  const renders: Array<{ container: Element; components: Array<Record<string, unknown>> }> = [];
  const window = {
    sessionStorage: {
      getItem(key: string) {
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        if (options.storageAvailable === false) throw new Error('storage unavailable');
        storage.set(key, value);
      },
      removeItem(key: string) {
        storage.delete(key);
      },
    },
    location: {
      reload: vi.fn(),
      get href() {
        return location.href;
      },
      set href(value: string) {
        location = new URL(value, location);
      },
      get hash() {
        return location.hash;
      },
      get search() {
        return location.search;
      },
      get pathname() {
        return location.pathname;
      },
    },
    history: {
      replaceState(_state: unknown, _title: string, href: string) {
        location = new URL(href, location);
      },
    },
    addEventListener(type: string, listener: () => void) {
      listeners[type] = listener;
    },
    KyberionPrefs: {
      locale: () => 'en',
      tenant: () => options.tenant || 'alpha',
      scopedUrl(path: string) {
        const url = new URL(path, location);
        url.searchParams.set('tenant', options.tenant || 'alpha');
        return url.origin === location.origin ? url.pathname + url.search + url.hash : url.href;
      },
    },
    FrontDeskRail: {
      ready: options.ready || Promise.resolve(),
      nav: async () => ({
        ok: true,
        items: [{ id: 'decide', href: 'https://decide.example.test/decide' }],
      }),
      render(container: Element, components: Array<Record<string, unknown>>) {
        renders.push({ container, components });
      },
    },
  };
  const fetch = vi.fn((url: string, input?: FetchInput) =>
    options.fetcher ? options.fetcher(url, input) : Promise.resolve(response({ ok: true }))
  );
  const document = {
    documentElement: { getAttribute: () => 'en' },
    getElementById: (id: string) => elements[id] || null,
    querySelector: () => null,
    createElement(tag: string) {
      const el = new Element();
      el.tag = tag;
      return el;
    },
    createElementNS(_ns: string, tag: string) {
      const el = new Element();
      el.tag = tag;
      return el;
    },
  };
  runInNewContext(
    safeReadFile(
      'presence/displays/presence-studio/static/' + (options.page || 'progress') + '.js',
      {}
    ).toString(),
    { window, document, fetch, URLSearchParams, URL, Promise }
  );
  return {
    elements,
    window: window as typeof window & {
      KyberionProgress: { mount(): Promise<void> };
      KyberionHome: { mount(): Promise<void> };
    },
    fetch,
    refresh,
    noticeText,
    renders,
    listeners,
  };
}

function dataFetcher(
  payload: ReturnType<typeof emptyPayload>,
  extras?: (path: string, options?: FetchInput) => Promise<MockResponse> | undefined
) {
  return (url: string, input?: FetchInput) => {
    const path = new URL(url, 'https://studio.example.test').pathname;
    const override = extras?.(path, input);
    if (override) return override;
    if (path.endsWith('-vocabulary')) return Promise.resolve(response({ ok: true, texts }));
    if (path === '/api/progress') return Promise.resolve(response(payload));
    if (path.startsWith('/api/progress/')) return Promise.resolve(response(detail(path)));
    return Promise.resolve(response({ ok: true }));
  };
}

describe('progress browser-script contracts', () => {
  it('waits for the validated scope before every initial read', async () => {
    const ready = deferred<void>();
    const h = harness({ ready: ready.promise, fetcher: dataFetcher(emptyPayload()) });
    const mounted = h.window.KyberionProgress.mount();
    await flush();
    expect(h.fetch).not.toHaveBeenCalled();
    ready.resolve();
    await mounted;
    expect(h.fetch.mock.calls.length).toBeGreaterThan(1);
    for (const [url] of h.fetch.mock.calls)
      expect(new URL(url, 'https://studio.example.test').searchParams.get('tenant')).toBe('alpha');
  });
  it('recovers an initial vocabulary failure on refresh without showing unlabelled controls', async () => {
    let vocabularyAvailable = false;
    const payload = emptyPayload();
    payload.active = [{ id: 'work', title: 'Work' }];
    const h = harness({
      fetcher: dataFetcher(payload, (path) =>
        path === '/api/progress-vocabulary' && !vocabularyAvailable
          ? Promise.resolve(response({ ok: false }, false))
          : undefined
      ),
    });
    await h.window.KyberionProgress.mount();
    expect(h.noticeText.textContent).toContain('Could not load');
    expect(h.fetch.mock.calls.some(([url]) => url === '/api/progress?tenant=alpha')).toBe(false);
    vocabularyAvailable = true;
    h.refresh.fire();
    await flush();
    expect(h.elements['progress-list'].children[0].children[0].innerHTML).toContain('In progress');
    expect(h.elements['progress-notice'].hidden).toBe(true);
  });

  it('keeps Enter inside a revision note from selecting the row or discarding the form', async () => {
    const payload = emptyPayload();
    payload.delivered = [
      { id: 'artifact', title: 'Result', can_verdict: true, entry_id: 'inbox-1' },
    ];
    const h = harness({ hash: '#artifact', fetcher: dataFetcher(payload) });
    await h.window.KyberionProgress.mount();
    const row = h.elements['progress-list'].children[0].children[0];
    row.querySelector('[data-action="revise"]')!.fire();
    const preventDefault = vi.fn();
    const calls = h.fetch.mock.calls.length;
    row.fire('keydown', {
      key: 'Enter',
      preventDefault,
      target: { closest: (selector: string) => selector === '.progress-revise-form' },
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(h.fetch.mock.calls.length).toBe(calls);
    expect(row.querySelector('.progress-revise-form')).not.toBeNull();
  });

  it('renders distinct historical outcomes with discussion recovery and scoped artifact/screen links', async () => {
    const payload = emptyPayload();
    payload.done = [
      'completed',
      'failed',
      'released',
      'accepted',
      'rejected',
      'changes_requested',
    ].map((status) => ({
      id: status,
      status,
      title: status,
      kind: ['accepted', 'rejected', 'changes_requested'].includes(status)
        ? 'artifact'
        : 'task_session',
      downloadable: true,
    }));
    const h = harness({ hash: '#rejected', fetcher: dataFetcher(payload) });
    await h.window.KyberionProgress.mount();
    const html = h.elements['progress-list'].children
      .map((li) => li.children[0].innerHTML)
      .join('\n');
    for (const label of [
      'Completed',
      'Failed',
      'Released',
      'Accepted',
      'Sent back',
      'Changes requested',
    ])
      expect(html).toContain(label);
    expect(html).not.toContain('Finished');
    expect(h.elements['filter-done'].textContent).toBe('History');
    expect(html).toContain('/ask?ask=About+rejected&amp;tenant=alpha');
    expect(html).toContain('/api/artifacts/rejected?tenant=alpha');
    expect(h.elements['progress-detail'].innerHTML).toContain(
      'https://screen.example.test/computer/?tenant=alpha'
    );
  });
  it('never substitutes unrelated work for an unmatched request and resolves a real correlation after refresh', async () => {
    const payload = emptyPayload();
    payload.active = [{ id: 'other-work', title: 'Other work', selected_default: true }];
    const h = harness({ search: '?request=new-request', fetcher: dataFetcher(payload) });
    await h.window.KyberionProgress.mount();
    expect(h.noticeText.textContent).toContain('No tracked work');
    expect(h.window.location.hash).toBe('');
    expect(h.fetch.mock.calls.some(([url]) => url.startsWith('/api/progress/'))).toBe(false);
    payload.active.push({
      id: 'real-work-id',
      title: 'Requested work',
      correlation_id: 'new-request',
    });
    h.refresh.fire();
    await flush();
    expect(h.window.location.hash).toBe('#real-work-id');
    expect(
      h.fetch.mock.calls.some(([url]) => url === '/api/progress/real-work-id?tenant=alpha')
    ).toBe(true);
  });
  it('selects a terminal record by real correlation and ignores malformed hash encoding', async () => {
    const payload = emptyPayload();
    payload.done = [
      { id: 'failed-work', title: 'Failed', status: 'failed', correlation_id: 'request-1' },
    ];
    const h = harness({
      search: '?request=request-1',
      hash: '#%E0%A4%A',
      fetcher: dataFetcher(payload),
    });
    await h.window.KyberionProgress.mount();
    expect(h.window.location.hash).toBe('#failed-work');
    expect(h.elements['progress-detail'].innerHTML).toContain('Failed');
  });
  it.each(['#missing', '#%E0%A4%A'])(
    'never substitutes a default for unresolved explicit target %s',
    async (hash) => {
      const payload = emptyPayload();
      payload.active = [{ id: 'unrelated', title: 'Other', selected_default: true }];
      const h = harness({ hash, fetcher: dataFetcher(payload) });
      await h.window.KyberionProgress.mount();
      expect(h.window.location.hash).toBe(hash);
      expect(h.noticeText.textContent).toContain('work item is unavailable');
      expect(h.fetch.mock.calls.some(([url]) => url.startsWith('/api/progress/'))).toBe(false);
      h.elements['progress-list'].children[0].children[0].fire();
      await flush();
      expect(h.window.location.hash).toBe('#unrelated');
      expect(h.elements['progress-notice'].hidden).toBe(true);
    }
  );
  it('does not replace a valid missing hash with a matching request correlation', async () => {
    const payload = emptyPayload();
    payload.active = [
      { id: 'other', title: 'Other', correlation_id: 'request-1', selected_default: true },
    ];
    const h = harness({
      hash: '#missing',
      search: '?request=request-1',
      fetcher: dataFetcher(payload),
    });
    await h.window.KyberionProgress.mount();
    expect(h.window.location.hash).toBe('#missing');
    expect(h.fetch.mock.calls.some(([url]) => url.startsWith('/api/progress/'))).toBe(false);
  });
  it('preserves a disappeared target across refresh and resolves its later delivery', async () => {
    const payload = emptyPayload();
    payload.active = [
      { id: 'target', title: 'Target' },
      { id: 'other', title: 'Other', selected_default: true },
    ];
    const h = harness({ hash: '#target', fetcher: dataFetcher(payload) });
    await h.window.KyberionProgress.mount();
    payload.active.shift();
    h.fetch.mockClear();
    h.refresh.fire();
    await flush();
    expect(h.window.location.hash).toBe('#target');
    expect(h.elements['progress-detail'].innerHTML).not.toContain('/api/progress/target');
    expect(h.noticeText.textContent).toContain('work item is unavailable');
    expect(h.fetch.mock.calls.some(([url]) => url.startsWith('/api/progress/'))).toBe(false);
    payload.delivered = [{ id: 'target', title: 'Delivered target' }];
    h.refresh.fire();
    await flush();
    expect(h.window.location.hash).toBe('#target');
    expect(h.elements['filter-delivered'].attributes['aria-selected']).toBe('true');
    expect(h.elements['progress-detail'].innerHTML).toContain('/api/progress/target');
    expect(h.elements['progress-notice'].hidden).toBe(true);
  });
  it('clears selection and fences an old detail after an unknown hash navigation', async () => {
    const payload = emptyPayload();
    payload.active = [{ id: 'old', title: 'Old' }];
    const pending = deferred<MockResponse>();
    const h = harness({
      fetcher: dataFetcher(payload, (path) =>
        path === '/api/progress/old' ? pending.promise : undefined
      ),
    });
    await h.window.KyberionProgress.mount();
    h.elements['progress-list'].children[0].children[0].fire();
    h.window.location.href = '/progress#missing';
    h.listeners.hashchange();
    pending.resolve(response(detail('private stale content')));
    await flush();
    expect(h.window.location.hash).toBe('#missing');
    expect(h.elements['progress-detail'].innerHTML).not.toContain('private stale content');
    expect(h.noticeText.textContent).toContain('work item is unavailable');
  });
  it('resolves an encoded exact ID once and keeps implicit default selection', async () => {
    const payload = emptyPayload();
    const id = 'task/日本語 %2F';
    payload.done = [{ id, title: 'Exact' }];
    payload.active = [{ id: 'default', title: 'Default', selected_default: true }];
    const h = harness({ hash: '#' + encodeURIComponent(id), fetcher: dataFetcher(payload) });
    await h.window.KyberionProgress.mount();
    expect(
      h.fetch.mock.calls.some(
        ([url]) => url === '/api/progress/' + encodeURIComponent(id) + '?tenant=alpha'
      )
    ).toBe(true);
    expect(h.elements['filter-done'].attributes['aria-selected']).toBe('true');
    const implicit = harness({ fetcher: dataFetcher(payload) });
    await implicit.window.KyberionProgress.mount();
    expect(implicit.window.location.hash).toBe('#default');
  });
  it('clears old detail immediately when refresh begins and ignores its late response', async () => {
    const payload = emptyPayload();
    payload.active = [{ id: 'old', title: 'Old' }];
    const staleDetail = deferred<MockResponse>();
    const pendingList = deferred<MockResponse>();
    let reads = 0;
    const h = harness({
      fetcher: dataFetcher(payload, (path) => {
        if (path === '/api/progress' && ++reads === 2) return pendingList.promise;
        if (path === '/api/progress/old') return staleDetail.promise;
        return undefined;
      }),
    });
    await h.window.KyberionProgress.mount();
    h.elements['progress-list'].children[0].children[0].fire();
    h.refresh.fire();
    await flush();
    staleDetail.resolve(response(detail('old private bytes')));
    await flush();
    expect(h.elements['progress-detail'].innerHTML).not.toContain('old private bytes');
    expect(h.elements['progress-list'].children).toHaveLength(0);
    pendingList.resolve(response({ ok: false, error: 'private denial detail' }, false));
    await flush();
    h.elements['filter-active'].fire();
    h.listeners.hashchange();
    await flush();
    expect(h.elements['progress-list'].children).toHaveLength(0);
    expect(h.elements['progress-detail'].innerHTML).not.toContain('old private bytes');
    expect(h.noticeText.textContent).not.toContain('private denial detail');
    expect(h.window.location.hash).toBe('#old');
  });
  it.each([401, 403, 404])(
    'clears cached actions on detail denial %s without forgetting uncertain decisions',
    async (status) => {
      const payload = emptyPayload();
      payload.delivered = [
        { id: 'target', title: 'Private result', can_verdict: true, entry_id: 'inbox-1' },
      ];
      const key = 'front-desk.progress.uncertain.principal-alpha';
      const storage = new Map([[key, JSON.stringify(['inbox-1'])]]);
      const h = harness({
        hash: '#target',
        storage,
        fetcher: dataFetcher(payload, (path) =>
          path === '/api/progress/target'
            ? Promise.resolve({
                ...response({ ok: false, error: 'private context' }, false),
                status,
              })
            : undefined
        ),
      });
      await h.window.KyberionProgress.mount();
      h.elements['filter-delivered'].fire();
      h.listeners.hashchange();
      await flush();
      expect(h.elements['progress-list'].children).toHaveLength(0);
      expect(h.elements['progress-detail'].innerHTML).not.toContain('Private result');
      expect(h.noticeText.textContent).toContain('work item is unavailable');
      expect(storage.get(key)).toBe(JSON.stringify(['inbox-1']));
      expect(h.fetch.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true);
    }
  );
  it('handles query-only history traversal and reloads before changed-scope navigation', async () => {
    const payload = emptyPayload();
    payload.active = [
      { id: 'one', title: 'One', correlation_id: 'r1' },
      { id: 'two', title: 'Two', correlation_id: 'r2' },
    ];
    const h = harness({ search: '?request=r1', fetcher: dataFetcher(payload) });
    await h.window.KyberionProgress.mount();
    h.window.location.href = '/progress?request=r2';
    h.listeners.popstate();
    await flush();
    expect(h.window.location.hash).toBe('#two');
    h.window.location.href = '/progress?request=r1';
    h.listeners.popstate();
    await flush();
    expect(h.window.location.hash).toBe('#one');
    h.fetch.mockClear();
    h.window.location.href = '/progress?tenant=beta#two';
    h.listeners.popstate();
    await flush();
    expect(h.window.location.reload).toHaveBeenCalledOnce();
    expect(h.elements['progress-list'].children).toHaveLength(0);
    expect(h.elements['progress-detail'].innerHTML).not.toContain('/api/progress/one');
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('captures scope after the shared rail normalizes the URL', async () => {
    const ready = deferred<void>();
    const payload = emptyPayload();
    payload.active = [
      { id: 'one', title: 'One' },
      { id: 'two', title: 'Two' },
    ];
    const h = harness({ ready: ready.promise, hash: '#one', fetcher: dataFetcher(payload) });
    const mounted = h.window.KyberionProgress.mount();
    await flush();
    h.window.location.href = '/progress?tenant=alpha#one';
    ready.resolve();
    await mounted;
    h.window.location.href = '/progress?tenant=alpha#two';
    h.listeners.hashchange();
    await flush();
    expect(h.window.location.reload).not.toHaveBeenCalled();
    expect(h.elements['progress-detail'].innerHTML).toContain('/api/progress/two');
  });
  it('never restarts old-scope reads after a late verdict settles during navigation', async () => {
    const payload = emptyPayload();
    payload.delivered = [
      { id: 'target', title: 'Old tenant', can_verdict: true, entry_id: 'inbox-1' },
    ];
    const pending = deferred<MockResponse>();
    const storage = new Map<string, string>();
    const h = harness({
      hash: '#target',
      storage,
      fetcher: dataFetcher(payload, (_path, input) =>
        input?.method === 'POST' ? pending.promise : undefined
      ),
    });
    await h.window.KyberionProgress.mount();
    h.elements['progress-list'].children[0].children[0]
      .querySelector('[data-action="receive"]')!
      .fire();
    h.window.location.href = '/progress?tenant=beta#target';
    h.listeners.popstate();
    h.fetch.mockClear();
    pending.resolve(response({ ok: true }));
    h.refresh.fire();
    await flush();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.elements['progress-list'].children).toHaveLength(0);
    expect(h.elements['progress-detail'].innerHTML).not.toContain('Old tenant');
    expect(storage.get('front-desk.progress.uncertain.principal-alpha')).toBe(
      JSON.stringify(['inbox-1'])
    );
  });
  it('clears cached actions on non-JSON detail denial', async () => {
    const payload = emptyPayload();
    payload.delivered = [
      { id: 'target', title: 'Old result', can_verdict: true, entry_id: 'inbox-1' },
    ];
    const h = harness({
      hash: '#target',
      fetcher: dataFetcher(payload, (path) =>
        path === '/api/progress/target'
          ? Promise.resolve({
              ok: false,
              status: 403,
              json: async () => {
                throw new Error('gateway private error');
              },
            })
          : undefined
      ),
    });
    await h.window.KyberionProgress.mount();
    h.elements['filter-delivered'].fire();
    expect(h.elements['progress-list'].children).toHaveLength(0);
    expect(h.noticeText.textContent).toContain('work item is unavailable');
    expect(h.noticeText.textContent).not.toContain('gateway');
  });
  it('labels status-derived progress as a phase estimate and omits unqualified numeric bars', async () => {
    const payload = emptyPayload();
    payload.active = [
      { id: 'estimated', title: 'Estimated', percent: 65, progress_basis: 'phase_estimate' },
      { id: 'unqualified', title: 'Unknown basis', percent: 70 },
    ];
    const h = harness({ fetcher: dataFetcher(payload) });
    await h.window.KyberionProgress.mount();
    const rows = h.elements['progress-list'].children.map((li) => li.children[0]);
    expect(rows[0].innerHTML).toContain('Phase estimate');
    expect(rows[0].innerHTML).toContain('width:65%');
    expect(rows[1].innerHTML).not.toContain('width:70%');
  });
  it('keeps the newer selection when an older detail response arrives last', async () => {
    const payload = emptyPayload();
    payload.active = ['first', 'second'].map((id) => ({ id, title: id }));
    const first = deferred<MockResponse>();
    const second = deferred<MockResponse>();
    const h = harness({
      fetcher: dataFetcher(payload, (path) =>
        path === '/api/progress/first'
          ? first.promise
          : path === '/api/progress/second'
            ? second.promise
            : undefined
      ),
    });
    await h.window.KyberionProgress.mount();
    h.elements['progress-list'].children[0].children[0].fire();
    h.elements['progress-list'].children[1].children[0].fire();
    second.resolve(response(detail('newer selection')));
    await flush();
    first.resolve(response(detail('stale selection')));
    await flush();
    expect(h.elements['progress-detail'].innerHTML).toContain('newer selection');
    expect(h.elements['progress-detail'].innerHTML).not.toContain('stale selection');
  });
  it('shows generic detail unavailability and preserves the explicit URL target', async () => {
    const payload = emptyPayload();
    payload.active = [{ id: 'kept', title: 'Kept' }];
    const h = harness({
      hash: '#kept',
      fetcher: dataFetcher(payload, (path) =>
        path === '/api/progress/kept' ? Promise.resolve(response({ ok: false }, false)) : undefined
      ),
    });
    await h.window.KyberionProgress.mount();
    expect(h.noticeText.textContent).toContain('work item is unavailable');
    expect(h.elements['progress-list'].children).toHaveLength(0);
    expect(h.window.location.hash).toBe('#kept');
    expect(h.elements['progress-notice'].hidden).toBe(false);
  });
  it('restores pending locks after reload and isolates them by server-derived principal and scope', async () => {
    const payload = emptyPayload();
    payload.delivered = [
      { id: 'artifact', title: 'Result', can_verdict: true, entry_id: 'inbox-1', status: 'read' },
    ];
    const storage = new Map<string, string>();
    const write = deferred<MockResponse>();
    const first = harness({
      storage,
      hash: '#artifact',
      fetcher: dataFetcher(payload, (_path, options) =>
        options?.method === 'POST' ? write.promise : undefined
      ),
    });
    await first.window.KyberionProgress.mount();
    first.elements['progress-list'].children[0].children[0]
      .querySelector('[data-action="receive"]')!
      .fire();
    expect(storage.get('front-desk.progress.uncertain.principal-alpha')).toBe('["inbox-1"]');
    const reloaded = harness({ storage, hash: '#artifact', fetcher: dataFetcher(payload) });
    await reloaded.window.KyberionProgress.mount();
    expect(
      reloaded.elements['progress-list'].children[0].children[0].querySelector(
        '[data-action="receive"]'
      )!.disabled
    ).toBe(true);
    expect(reloaded.noticeText.textContent).toContain('uncertain');
    const otherPrincipal = harness({
      storage,
      tenant: 'alpha',
      hash: '#artifact',
      fetcher: dataFetcher({ ...payload, viewer_scope_id: 'other-principal-alpha' }),
    });
    await otherPrincipal.window.KyberionProgress.mount();
    expect(
      otherPrincipal.elements['progress-list'].children[0].children[0].querySelector(
        '[data-action="receive"]'
      )!.disabled
    ).toBe(false);
    expect(storage.get('front-desk.progress.uncertain.principal-alpha')).toBe('["inbox-1"]');
    // A delayed commit can arrive after the page is reconstructed.
    payload.delivered = [];
    payload.done = [
      {
        id: 'artifact',
        entry_id: 'inbox-1',
        title: 'Result',
        status: 'accepted',
        kind: 'artifact',
      },
    ];
    reloaded.refresh.fire();
    await flush();
    expect(storage.has('front-desk.progress.uncertain.principal-alpha')).toBe(false);
    expect(reloaded.elements['progress-notice'].hidden).toBe(true);
  });

  it('disables verdicts when the read lacks a server-derived viewer scope identifier', async () => {
    const payload = emptyPayload();
    payload.viewer_scope_id = undefined;
    payload.delivered = [
      { id: 'artifact', title: 'Result', can_verdict: true, entry_id: 'inbox-1', status: 'read' },
    ];
    const h = harness({ hash: '#artifact', fetcher: dataFetcher(payload) });
    await h.window.KyberionProgress.mount();
    const receive =
      h.elements['progress-list'].children[0].children[0].querySelector('[data-action="receive"]')!;
    expect(receive.disabled).toBe(true);
    receive.fire();
    expect(h.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
    expect(h.noticeText.textContent).toContain('scope could not be verified');
    payload.viewer_scope_id = 'principal-alpha';
    h.refresh.fire();
    await flush();
    expect(
      h.elements['progress-list'].children[0].children[0].querySelector('[data-action="receive"]')!
        .disabled
    ).toBe(false);
  });

  it('preserves unread lock storage when getItem throws even though writes still work', async () => {
    const key = 'front-desk.progress.uncertain.principal-alpha';
    const storage = new Map([[key, '["inbox-1"]']]);
    const payload = emptyPayload();
    payload.delivered = [
      { id: 'artifact', title: 'Result', can_verdict: true, entry_id: 'inbox-1', status: 'read' },
    ];
    const h = harness({ storage, hash: '#artifact', fetcher: dataFetcher(payload) });
    const get = vi.spyOn(h.window.sessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('temporary read failure');
    });
    const set = vi.spyOn(h.window.sessionStorage, 'setItem');
    const remove = vi.spyOn(h.window.sessionStorage, 'removeItem');
    await h.window.KyberionProgress.mount();
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(storage.get(key)).toBe('["inbox-1"]');
    const receive =
      h.elements['progress-list'].children[0].children[0].querySelector('[data-action="receive"]')!;
    expect(receive.disabled).toBe(true);
    receive.fire();
    expect(h.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
    expect(h.noticeText.textContent).toContain('Allow session storage');
    get.mockRestore();
    h.refresh.fire();
    await flush();
    expect(
      h.elements['progress-list'].children[0].children[0].querySelector('[data-action="receive"]')!
        .disabled
    ).toBe(true);
    expect(h.noticeText.textContent).toContain('uncertain');
    expect(storage.get(key)).toBe('["inbox-1"]');
    payload.delivered = [];
    payload.done = [
      {
        id: 'artifact',
        entry_id: 'inbox-1',
        title: 'Result',
        status: 'accepted',
        kind: 'artifact',
      },
    ];
    h.refresh.fire();
    await flush();
    expect(storage.has(key)).toBe(false);
    expect(h.elements['progress-notice'].hidden).toBe(true);
  });

  it.each(['{broken', '', '{}', '[null]'])(
    'retains invalid lock storage %j and stays fail-closed',
    async (invalid) => {
      const key = 'front-desk.progress.uncertain.principal-alpha';
      const storage = new Map([[key, invalid]]);
      const payload = emptyPayload();
      payload.delivered = [
        { id: 'artifact', title: 'Result', can_verdict: true, entry_id: 'inbox-1', status: 'read' },
      ];
      const h = harness({ storage, hash: '#artifact', fetcher: dataFetcher(payload) });
      const set = vi.spyOn(h.window.sessionStorage, 'setItem');
      const remove = vi.spyOn(h.window.sessionStorage, 'removeItem');
      await h.window.KyberionProgress.mount();
      h.refresh.fire();
      await flush();
      expect(set).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(storage.get(key)).toBe(invalid);
      expect(
        h.elements['progress-list'].children[0].children[0].querySelector(
          '[data-action="receive"]'
        )!.disabled
      ).toBe(true);
      expect(h.noticeText.textContent).toContain('Allow session storage');
      expect(h.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(
        0
      );
    }
  );

  it('does not send a decision if its reload-safety lock cannot be stored', async () => {
    const payload = emptyPayload();
    payload.delivered = [
      { id: 'artifact', title: 'Result', can_verdict: true, entry_id: 'inbox-1', status: 'read' },
    ];
    const h = harness({
      storageAvailable: false,
      hash: '#artifact',
      fetcher: dataFetcher(payload),
    });
    await h.window.KyberionProgress.mount();
    h.elements['progress-list'].children[0].children[0]
      .querySelector('[data-action="receive"]')!
      .fire();
    await flush();
    expect(h.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
    expect(h.noticeText.textContent).toContain('Allow session storage');
  });

  it('never reconciles an uncertain verdict using a read begun before that uncertainty', async () => {
    const payload = emptyPayload();
    payload.delivered = [
      { id: 'artifact', title: 'Result', can_verdict: true, entry_id: 'inbox-1', status: 'read' },
    ];
    const write = deferred<MockResponse>();
    const staleRead = deferred<MockResponse>();
    let reads = 0;
    const h = harness({
      hash: '#artifact',
      fetcher: dataFetcher(payload, (path, options) => {
        if (options?.method === 'POST') return write.promise;
        if (path === '/api/progress' && ++reads === 2) return staleRead.promise;
        return undefined;
      }),
    });
    await h.window.KyberionProgress.mount();
    const initialButton =
      h.elements['progress-list'].children[0].children[0].querySelector('[data-action="receive"]')!;
    initialButton.fire();
    h.refresh.fire();
    await flush();
    expect(reads).toBe(2);
    write.reject(new Error('response lost after possible commit'));
    await flush();
    expect(h.noticeText.textContent).toContain('uncertain');
    staleRead.resolve(response(payload));
    await flush();
    const staleButton =
      h.elements['progress-list'].children[0].children[0].querySelector('[data-action="receive"]')!;
    expect(staleButton.disabled).toBe(true);
    expect(h.elements['progress-notice'].hidden).toBe(false);
    expect(h.noticeText.textContent).toContain('uncertain');
    staleButton.fire();
    expect(h.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    // A newer GET may still race a delayed commit: unchanged status is not proof.
    h.refresh.fire();
    await flush();
    const stillUncertain =
      h.elements['progress-list'].children[0].children[0].querySelector('[data-action="receive"]')!;
    expect(stillUncertain.disabled).toBe(true);
    expect(h.elements['progress-notice'].hidden).toBe(false);
    // The exact inbox entry's terminal state is the first conclusive evidence.
    payload.delivered = [];
    payload.done = [
      {
        id: 'artifact',
        entry_id: 'inbox-1',
        title: 'Result',
        status: 'accepted',
        kind: 'artifact',
      },
    ];
    h.refresh.fire();
    await flush();
    expect(h.elements['progress-list'].children[0].children[0].innerHTML).toContain('Accepted');
    expect(h.elements['progress-notice'].hidden).toBe(true);
    expect(h.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('blocks duplicate and uncertain decisions until a successful refresh confirms status', async () => {
    const payload = emptyPayload();
    payload.delivered = [
      { id: 'artifact', title: 'Result', can_verdict: true, entry_id: 'inbox-1', status: 'read' },
    ];
    const write = deferred<MockResponse>();
    const h = harness({
      hash: '#artifact',
      fetcher: dataFetcher(payload, (_path, options) =>
        options?.method === 'POST' ? write.promise : undefined
      ),
    });
    await h.window.KyberionProgress.mount();
    const button =
      h.elements['progress-list'].children[0].children[0].querySelector('[data-action="receive"]')!;
    button.fire();
    button.fire();
    expect(h.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    const mutation = h.fetch.mock.calls.find(([, options]) => options?.method === 'POST')!;
    expect(mutation[0]).toBe('/api/outcomes/inbox-1/verdict?tenant=alpha');
    expect(JSON.parse(mutation[1].body)).toMatchObject({
      status: 'accepted',
      viewer_scope_id: 'principal-alpha',
    });
    write.reject(new Error('connection lost after possible write'));
    await flush();
    expect(h.noticeText.textContent).toContain('uncertain');
    expect(button.disabled).toBe(true);
    button.fire();
    expect(h.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    payload.delivered = [];
    payload.done = [
      {
        id: 'artifact',
        entry_id: 'inbox-1',
        title: 'Result',
        status: 'accepted',
        kind: 'artifact',
      },
    ];
    h.refresh.fire();
    await flush();
    expect(h.elements['progress-list'].children[0].children[0].innerHTML).toContain('Accepted');
    expect(h.elements['progress-notice'].hidden).toBe(true);
  });
});

describe('work home browser-script scope readiness', () => {
  it('waits for scope validation and preserves scope on explicit new-request navigation', async () => {
    const ready = deferred<void>();
    const h = harness({
      page: 'home',
      ready: ready.promise,
      fetcher: async (url) => {
        const path = new URL(url, 'https://studio.example.test').pathname;
        if (path.endsWith('-vocabulary')) return response({ ok: true, texts });
        if (path === '/api/home')
          return response({
            ok: true,
            work_home: {
              version: 1,
              scope_id: 'scope-alpha',
              observed_at: '2026-10-05T00:00:00Z',
              coverage: 'supported_sources_ready',
              sources: [],
              items: [],
              attention: [],
              updates: [],
              counts: { all: 0, attention: 0, active: 0, answered: 0, verified: 0 },
            },
          });
        return response({ ok: true });
      },
    });
    const mounted = h.window.KyberionHome.mount();
    await flush();
    expect(h.fetch).not.toHaveBeenCalled();
    ready.resolve();
    await mounted;
    expect(h.fetch.mock.calls.some(([url]) => url === '/api/home?tenant=alpha')).toBe(true);
    expect(h.fetch.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true);
    h.elements['ask-input'].value = 'Prepare my request';
    h.elements['ask-form'].fire('submit');
    expect(h.window.location.href).toBe(
      'https://studio.example.test/ask?ask=Prepare+my+request&send=1&tenant=alpha'
    );
  });
});

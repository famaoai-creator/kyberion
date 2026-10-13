import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { safeReadFile } from '@agent/core/secure-io';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

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
    if (key === 'data-action') this.action = value;
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
            : selector === '.progress-revise-note'
              ? child.className === 'kb-input kb-textarea progress-revise-note'
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
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}
const texts: Record<string, string> = {
  'front_desk:progress_leave_title': 'Leave this page?',
  'front_desk:progress_leave_draft':
    'Your correction draft has not been recorded. Leaving this page discards it.',
  'front_desk:progress_leave_pending':
    'A decision is still being recorded. Leaving does not cancel it and discards any draft text on this page. Check Progress when you return before trying again.',
  'front_desk:progress_leave_uncertain':
    'A decision still needs confirmation from the latest progress. Leaving discards any draft text on this page. Your pending decision remains protected from duplicate submission. Check Progress when you return.',
  'front_desk:progress_leave_stay_page': 'Stay on this page',
  'front_desk:progress_leave_stay': 'Keep editing',
  'front_desk:progress_leave_discard': 'Discard and leave',
  'front_desk:progress_leave_anyway': 'Leave anyway',
  'front_desk:progress_leave_unavailable':
    'The leave confirmation could not be displayed. Your draft is unchanged. Try the navigation again.',
  'front_desk:progress_correction_recorded': 'Correction feedback recorded',
  'front_desk:progress_correction_prepare': 'Prepare correction request',
  'front_desk:progress_history': 'History',
  'front_desk:progress_filter_active': 'In progress {count}',
  'front_desk:progress_filter_delivered': 'Delivered {count}',
  'front_desk:progress_delivered_title': 'Delivered',
  'front_desk:progress_empty_active': 'Nothing is in progress.',
  'front_desk:progress_select_hint': 'Choose an item to see its details.',
  'front_desk:progress_loading': 'Loading progress…',
  'front_desk:progress_refreshing': 'Checking the latest progress…',
  'front_desk:progress_detail_loading': 'Loading details for {title}…',
  'front_desk:progress_detail_failed': 'Could not load details for {title}.',
  'front_desk:progress_detail_ready': 'Details for {title}',
  'front_desk:progress_detail_retry': 'Try loading details again',
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
    withoutAbort?: boolean;
    fetcher?: (path: string, options?: FetchInput) => Promise<MockResponse>;
  } = {}
) {
  const ids = [
    'progress-leave-dialog',
    'filter-active',
    'filter-delivered',
    'filter-done',
    'progress-list',
    'progress-empty',
    'progress-detail',
    'progress-read-status',
    'progress-detail-status',
    'progress-detail-retry',
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
  elements['progress-read-status'].setAttribute('data-progress_loading', 'Loading progress…');
  elements['progress-read-status'].setAttribute(
    'data-progress_refreshing',
    'Checking the latest progress…'
  );
  const noticeText = new Element();
  noticeText.setAttribute('data-notice-text', 'true');
  const refresh = new Element();
  refresh.tag = 'button';
  elements['progress-notice'].appendChild(noticeText);
  elements['progress-notice'].appendChild(refresh);
  Object.entries(texts).forEach(([key, value]) =>
    elements['progress-notice'].setAttribute('data-' + key.replace('front_desk:', ''), value)
  );
  elements['progress-detail-retry'].tag = 'button';
  let location = new URL(
    'https://studio.example.test/' +
      (options.page || 'progress') +
      (options.search || '') +
      (options.hash || '')
  );
  const listeners: Record<string, () => void> = {};
  const storage = options.storage || new Map<string, string>();
  type RenderOptions = {
    isCurrent?: () => boolean;
    onAction?: (action: { id: string; payload?: { choice: string } }) => void;
  };
  const renders: Array<{
    container: Element;
    components: Array<Record<string, unknown>>;
    options?: RenderOptions;
  }> = [];
  const documentListeners: Record<string, (event: MockEvent) => void> = {};
  const shellListeners: Array<(state: { phase: string; message: string }) => void> = [];
  const window = {
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    AbortController: options.withoutAbort ? undefined : AbortController,
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
      assign: vi.fn(),
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
      state: null,
      pushState: vi.fn((_state: unknown, _title: string, href: string) => {
        location = new URL(href, location);
      }),
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
      subscribe(listener: (state: { phase: string; message: string }) => void) {
        shellListeners.push(listener);
        return () => {};
      },
      ready: options.ready || Promise.resolve(),
      nav: async () => ({
        ok: true,
        items: [{ id: 'decide', href: 'https://decide.example.test/decide' }],
      }),
      render(
        container: Element,
        components: Array<Record<string, unknown>>,
        options?: RenderOptions
      ) {
        renders.push({ container, components, options });
      },
    },
  };
  const fetch = vi.fn((url: string, input?: FetchInput) =>
    options.fetcher ? options.fetcher(url, input) : Promise.resolve(response({ ok: true }))
  );
  const document = {
    documentElement: { getAttribute: () => 'en' },
    addEventListener(type: string, listener: (event: MockEvent) => void) {
      documentListeners[type] = listener;
    },
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
    shell: (phase: string, message = '') =>
      shellListeners.forEach((listener) => listener({ phase, message })),
    window: window as typeof window & {
      KyberionProgress: { mount(): Promise<void> };
      FrontDeskPageLeave: {
        begin(): () => boolean;
        requestLeave(proceed: () => void, isCurrent?: () => boolean, cancel?: () => void): void;
      };
      KyberionHome: { mount(): Promise<void> };
    },
    fetch,
    refresh,
    noticeText,
    renders,
    documentListeners,
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
  it('keeps pending and failed list reads distinct from a verified empty result', async () => {
    const pending = deferred<MockResponse>();
    let reads = 0;
    const h = harness({
      fetcher: dataFetcher(emptyPayload(), (path) =>
        path === '/api/progress' && ++reads === 1 ? pending.promise : undefined
      ),
    });
    const mounted = h.window.KyberionProgress.mount();
    await flush();
    expect(h.elements['filter-active'].textContent).toBe('In progress');
    expect(h.elements['filter-delivered'].textContent).toBe('Delivered');
    expect(h.elements['progress-empty'].textContent).toBe('');
    expect(h.elements['progress-read-status'].textContent).toBe('Loading progress…');
    expect(h.elements['progress-list'].attributes['aria-busy']).toBe('true');
    pending.reject(new Error('private transport information'));
    await mounted;
    expect(h.elements['progress-list'].attributes['aria-busy']).toBe('false');
    expect(h.elements['progress-empty'].textContent).toBe('');
    expect(h.elements['filter-active'].textContent).toBe('In progress');
    expect(h.noticeText.textContent).toContain('Could not load');
    h.refresh.fire();
    await flush();
    expect(h.elements['filter-active'].textContent).toBe('In progress 0');
    expect(h.elements['progress-empty'].textContent).toBe('Nothing is in progress.');
  });
  it('labels a revalidation while clearing old data and keeping its target URL', async () => {
    const payload = emptyPayload();
    payload.active = [{ id: 'old', title: 'Old', selected_default: true }];
    payload.counts.active = 1;
    const pending = deferred<MockResponse>();
    let reads = 0;
    const h = harness({
      fetcher: dataFetcher(payload, (path) =>
        path === '/api/progress' && ++reads === 2 ? pending.promise : undefined
      ),
    });
    await h.window.KyberionProgress.mount();
    h.refresh.fire();
    await flush();
    expect(h.elements['progress-list'].children).toHaveLength(0);
    expect(h.elements['progress-detail'].innerHTML).not.toContain('/api/progress/old');
    expect(h.elements['progress-read-status'].textContent).toBe('Checking the latest progress…');
    expect(h.elements['filter-active'].textContent).toBe('In progress');
    expect(h.window.location.hash).toBe('#old');
    pending.resolve(response(payload));
    await flush();
    expect(h.elements['filter-active'].textContent).toBe('In progress 1');
    expect(h.elements['progress-read-status'].textContent).toBe('');
  });
  it('identifies selected-detail loading and retries only that failed GET once', async () => {
    const payload = emptyPayload();
    payload.active = [{ id: 'alpha', title: 'Alpha', selected_default: true }];
    const first = deferred<MockResponse>();
    const retry = deferred<MockResponse>();
    let details = 0;
    const h = harness({
      fetcher: dataFetcher(payload, (path) =>
        path === '/api/progress/alpha'
          ? ++details === 1
            ? first.promise
            : retry.promise
          : undefined
      ),
    });
    const mounted = h.window.KyberionProgress.mount();
    await flush();
    expect(h.elements['progress-detail-status'].textContent).toBe('Loading details for Alpha…');
    expect(h.elements['progress-detail'].innerHTML).not.toContain('Choose an item');
    expect(h.elements['progress-detail'].attributes['aria-busy']).toBe('true');
    first.reject(new Error('private network failure'));
    await mounted;
    expect(h.elements['progress-detail-status'].textContent).toBe(
      'Could not load details for Alpha.'
    );
    expect(h.elements['progress-detail'].attributes['aria-busy']).toBe('false');
    expect(h.elements['progress-detail-retry'].hidden).toBe(false);
    const before = h.fetch.mock.calls.length;
    h.elements['progress-detail-retry'].fire();
    h.elements['progress-detail-retry'].fire();
    await flush();
    expect(h.fetch.mock.calls.length).toBe(before + 1);
    expect(h.fetch.mock.calls.at(-1)?.[0]).toBe('/api/progress/alpha?tenant=alpha');
    expect(h.elements['progress-detail-retry'].disabled).toBe(true);
    retry.resolve(response(detail('confirmed Alpha')));
    await flush();
    expect(h.elements['progress-detail-status'].textContent).toBe('Details for Alpha');
    expect(h.elements['progress-detail'].innerHTML).toContain('confirmed Alpha');
    expect(h.elements['progress-detail'].attributes['aria-busy']).toBe('false');
    expect(h.fetch.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true);
  });

  it('clears the failed-read notice during one pending refresh and keeps counts unknown', async () => {
    let reads = 0;
    const pending = deferred<MockResponse>();
    const h = harness({
      fetcher: dataFetcher(emptyPayload(), (path) =>
        path === '/api/progress'
          ? ++reads === 1
            ? Promise.reject(new Error('offline'))
            : pending.promise
          : undefined
      ),
    });
    await h.window.KyberionProgress.mount();
    expect(h.elements['progress-notice'].hidden).toBe(false);
    h.refresh.fire();
    h.refresh.fire();
    await flush();
    expect(reads).toBe(2);
    expect(h.refresh.disabled).toBe(true);
    expect(h.elements['progress-notice'].hidden).toBe(true);
    expect(h.elements['progress-read-status'].textContent).toBe('Loading progress…');
    expect(h.elements['progress-empty'].textContent).toBe('');
    pending.resolve(response(emptyPayload()));
    await flush();
    expect(h.refresh.disabled).toBe(false);
  });
  it('keeps late detail failures from replacing newer selection feedback or enabling old retry', async () => {
    const payload = emptyPayload();
    payload.active = [
      { id: 'alpha', title: 'Alpha' },
      { id: 'beta', title: 'Beta' },
    ];
    const first = deferred<MockResponse>();
    const second = deferred<MockResponse>();
    const h = harness({
      fetcher: dataFetcher(payload, (path) =>
        path === '/api/progress/alpha'
          ? first.promise
          : path === '/api/progress/beta'
            ? second.promise
            : undefined
      ),
    });
    await h.window.KyberionProgress.mount();
    h.elements['progress-list'].children[0].children[0].fire();
    h.elements['progress-list'].children[1].children[0].fire();
    expect(h.elements['progress-detail-status'].textContent).toBe('Loading details for Beta…');
    first.reject(new Error('old failure'));
    await flush();
    expect(h.elements['progress-detail-status'].textContent).toBe('Loading details for Beta…');
    expect(h.elements['progress-detail-retry'].hidden).toBe(true);
    second.resolve({ ...response({ ok: false, error: 'private detail' }, false), status: 500 });
    await flush();
    expect(h.elements['progress-detail-status'].textContent).toBe(
      'Could not load details for Beta.'
    );
    h.elements['filter-delivered'].fire();
    expect(h.elements['progress-detail-status'].textContent).toBe('');
    expect(h.elements['progress-detail-retry'].hidden).toBe(true);
    expect(h.elements['progress-detail'].attributes['aria-busy']).toBe('false');
  });
  it('places live feedback outside busy content without announcing all result details', () => {
    const html = safeReadFile(
      'presence/displays/presence-studio/static/progress.html',
      {}
    ).toString();
    expect(html).toMatch(/id="progress-read-status"[^>]*role="status"/);
    expect(html).toMatch(/id="progress-detail-status"[^>]*role="status"/);
    expect(html).toMatch(/id="progress-list"[^>]*aria-busy="true"/);
    expect(html).toMatch(/id="progress-detail"[^>]*aria-busy="false"/);
    expect(html).not.toMatch(/id="progress-detail"[^>]*(?:role="status"|aria-live)/);
    const css = safeReadFile(
      'presence/displays/presence-studio/static/progress.css',
      {}
    ).toString();
    expect(css).not.toMatch(/#progress-(?:read|detail)-status:empty/);
    expect(html.indexOf('id="progress-detail-status"')).toBeLessThan(
      html.indexOf('id="progress-detail"')
    );
  });

  it.each(['active', 'delivered', 'done'])(
    'restores explicit %s filter without selecting unrelated default work',
    async (filter) => {
      const payload = emptyPayload();
      payload.active = [{ id: 'unrelated', title: 'Other work', selected_default: true }];
      const h = harness({ search: '?filter=' + filter, fetcher: dataFetcher(payload) });
      await h.window.KyberionProgress.mount();
      expect(h.elements['filter-' + filter].attributes['aria-selected']).toBe('true');
      expect(h.window.location.hash).toBe('');
      expect(h.fetch.mock.calls.some(([url]) => url.startsWith('/api/progress/'))).toBe(false);
    }
  );
  it('pushes distinct filter choices, preserves scope, and replays query-only Back Forward', async () => {
    const h = harness({
      search: '?tenant=alpha&organizationId=org&projectId=project&extra=kept',
      fetcher: dataFetcher(emptyPayload()),
    });
    await h.window.KyberionProgress.mount();
    const initial = h.window.location.href;
    h.elements['filter-delivered'].fire();
    const delivered = h.window.location.href;
    h.elements['filter-done'].fire();
    const done = h.window.location.href;
    h.elements['filter-done'].fire();
    expect(h.window.history.pushState).toHaveBeenCalledTimes(2);
    for (const href of [delivered, done]) {
      const query = new URL(href).searchParams;
      expect(query.get('tenant')).toBe('alpha');
      expect(query.get('organizationId')).toBe('org');
      expect(query.get('projectId')).toBe('project');
      expect(query.get('extra')).toBe('kept');
    }
    for (const [href, filter] of [
      [delivered, 'delivered'],
      [initial, 'active'],
      [done, 'done'],
    ]) {
      h.window.location.href = href;
      h.listeners.popstate();
      await flush();
      expect(h.elements['filter-' + filter].attributes['aria-selected']).toBe('true');
    }
    expect(h.window.location.reload).not.toHaveBeenCalled();
    expect(h.window.history.pushState).toHaveBeenCalledTimes(2);
  });
  it('clears old request and item targeting on explicit tab choice and fences a late detail', async () => {
    const payload = emptyPayload();
    payload.active = [{ id: 'requested', title: 'Requested work', correlation_id: 'r1' }];
    const pending = deferred<MockResponse>();
    const h = harness({
      search: '?tenant=alpha&request=r1',
      fetcher: dataFetcher(payload, (path) =>
        path === '/api/progress/requested' ? pending.promise : undefined
      ),
    });
    const mounted = h.window.KyberionProgress.mount();
    await flush();
    const original = h.window.location.href;
    expect(original).toContain('request=r1');
    expect(original).toContain('#requested');
    h.elements['filter-delivered'].fire();
    expect(h.window.location.search).toBe('?tenant=alpha&filter=delivered');
    expect(h.window.location.hash).toBe('');
    pending.resolve(response(detail('stale request detail')));
    await mounted;
    await flush();
    expect(h.elements['progress-detail'].innerHTML).not.toContain('stale request detail');
    const reloaded = harness({ search: h.window.location.search, fetcher: dataFetcher(payload) });
    await reloaded.window.KyberionProgress.mount();
    expect(reloaded.elements['filter-delivered'].attributes['aria-selected']).toBe('true');
    expect(reloaded.window.location.hash).toBe('');
    h.window.location.href = original;
    h.listeners.popstate();
    await flush();
    expect(h.elements['filter-active'].attributes['aria-selected']).toBe('true');
    expect(h.window.location.hash).toBe('#requested');
  });
  it('keeps explicit item and request precedence above conflicting filters without substituting missing items', async () => {
    const payload = emptyPayload();
    payload.active = [{ id: 'default', title: 'Default', selected_default: true }];
    payload.done = [{ id: 'target', title: 'Target', correlation_id: 'r1' }];
    for (const options of [
      { search: '?filter=delivered', hash: '#target' },
      { search: '?filter=delivered&request=r1', hash: '#%E0%A4%A' },
    ]) {
      const h = harness({ ...options, fetcher: dataFetcher(payload) });
      await h.window.KyberionProgress.mount();
      expect(h.elements['filter-done'].attributes['aria-selected']).toBe('true');
      expect(h.window.location.hash).toBe('#target');
    }
    const missing = harness({
      search: '?filter=delivered&request=r1',
      hash: '#missing',
      fetcher: dataFetcher(payload),
    });
    await missing.window.KyberionProgress.mount();
    expect(missing.window.location.hash).toBe('#missing');
    expect(missing.noticeText.textContent).toContain('work item is unavailable');
    expect(missing.fetch.mock.calls.some(([url]) => url.startsWith('/api/progress/'))).toBe(false);
    const invalid = harness({ search: '?filter=unrecognized', fetcher: dataFetcher(payload) });
    await invalid.window.KyberionProgress.mount();
    expect(invalid.window.location.hash).toBe('#default');
  });

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
      expect(h.elements['progress-detail-status'].textContent).toBe('');
      expect(h.elements['progress-detail-retry'].hidden).toBe(true);
      expect(h.elements['progress-detail'].attributes['aria-busy']).toBe('false');
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

describe('Progress shared shell startup feedback', () => {
  it('shows blocked copy without reading scoped data, then starts once after successful retry', async () => {
    const ready = deferred<void>();
    const h = harness({ ready: ready.promise, fetcher: dataFetcher(emptyPayload()) });
    const mounted = h.window.KyberionProgress.mount();
    await flush();
    h.shell('blocked', 'Sign in again, then Retry in the menu.');
    expect(h.elements['progress-read-status'].textContent).toBe(
      'Sign in again, then Retry in the menu.'
    );
    expect(h.elements['progress-list'].attributes['aria-busy']).toBe('false');
    expect(h.fetch).not.toHaveBeenCalled();
    h.shell('loading');
    expect(h.elements['progress-list'].attributes['aria-busy']).toBe('true');
    h.shell('ready');
    ready.resolve();
    await mounted;
    expect(
      h.fetch.mock.calls.filter(
        ([url]) => new URL(url, 'http://localhost').pathname === '/api/progress'
      )
    ).toHaveLength(1);
    expect(h.fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it('ignores readiness superseded before the consumer continuation', async () => {
    const ready = deferred<void>();
    const h = harness({ ready: ready.promise, fetcher: dataFetcher(emptyPayload()) });
    const mounted = h.window.KyberionProgress.mount();
    ready.resolve();
    h.window.FrontDeskRail.ready = new Promise(() => {});
    await mounted;
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

it('does not let a superseded vocabulary rejection erase the newer Progress mount', async () => {
  const old = deferred<MockResponse>();
  let reads = 0;
  const payload = emptyPayload();
  payload.active = [{ id: 'current', title: 'Current item', status: 'running' }];
  payload.counts.active = 1;
  const h = harness({
    fetcher: dataFetcher(payload, (path) =>
      path === '/api/progress-vocabulary' && ++reads === 1 ? old.promise : undefined
    ),
  });
  const first = h.window.KyberionProgress.mount();
  await flush();
  h.window.FrontDeskRail.ready = Promise.resolve();
  await h.window.KyberionProgress.mount();
  expect(h.elements['progress-list'].children).toHaveLength(1);
  const before = h.elements['progress-list'].children[0];
  old.reject(new Error('older request failed'));
  await first;
  expect(h.elements['progress-list'].children[0]).toBe(before);
  expect(h.noticeText.textContent).not.toContain('Could not load progress');
});

describe('Progress bounded read recovery', () => {
  const cases = ['vocabulary', 'list', 'detail'].flatMap((target) =>
    ['headers', 'body'].map((phase) => ({ target, phase }))
  );
  it.each(cases)(
    'recovers $target stalled $phase with one explicit GET retry',
    async ({ target, phase }) => {
      const payload = emptyPayload();
      payload.active = [{ id: 'alpha', title: 'Alpha' }];
      payload.counts.active = 1;
      const path =
        target === 'vocabulary'
          ? '/api/progress-vocabulary'
          : target === 'list'
            ? '/api/progress'
            : '/api/progress/alpha';
      const body =
        target === 'vocabulary'
          ? { ok: true, texts }
          : target === 'list'
            ? payload
            : detail('Recovered Alpha');
      const headers = deferred<MockResponse>();
      const stalledBody = deferred<unknown>();
      const retry = deferred<MockResponse>();
      let reads = 0;
      const h = harness({
        hash: '#alpha',
        fetcher: dataFetcher(payload, (url) => {
          if (url !== path) return;
          reads += 1;
          return reads === 1
            ? phase === 'headers'
              ? headers.promise
              : Promise.resolve({ ...response(body), json: () => stalledBody.promise })
            : retry.promise;
        }),
      });
      const mounted = h.window.KyberionProgress.mount();
      await flush();
      await vi.advanceTimersByTimeAsync(19999);
      expect(
        h.elements[target === 'detail' ? 'progress-detail-status' : 'progress-read-status']
          .textContent
      ).toContain('Loading');
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(
        h.elements[target === 'detail' ? 'progress-detail-status' : 'progress-notice'].hidden
      ).not.toBe(true);
      expect(
        target === 'detail'
          ? h.elements['progress-detail-status'].textContent
          : h.noticeText.textContent
      ).toContain('Could not load');
      const firstRead = h.fetch.mock.calls.find(([url]) => url.startsWith(path + '?'))!;
      expect((firstRead[1]?.signal as AbortSignal).aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      const button = target === 'detail' ? h.elements['progress-detail-retry'] : h.refresh;
      expect(button.disabled).toBe(false);
      expect(h.window.location.hash).toBe('#alpha');
      button.fire();
      button.fire();
      await flush();
      expect(reads).toBe(2);
      expect(button.disabled).toBe(true);
      retry.resolve(response(body));
      await flush();
      await mounted;
      expect(h.elements['progress-detail-status'].textContent).toBe('Details for Alpha');
      expect(h.elements['progress-detail'].innerHTML).toContain(
        target === 'detail' ? 'Recovered Alpha' : '/api/progress/alpha'
      );
      const beforeLate = h.fetch.mock.calls.length;
      const stale =
        target === 'detail'
          ? detail('STALE')
          : target === 'list'
            ? emptyPayload()
            : { ok: true, texts: { ...texts, 'front_desk:progress_detail_ready': 'STALE' } };
      headers.resolve(response(stale));
      stalledBody.resolve(stale);
      await flush();
      expect(h.elements['progress-detail'].innerHTML).not.toContain('STALE');
      expect(h.elements['progress-detail-status'].textContent).toBe('Details for Alpha');
      expect(h.elements['progress-list'].children).toHaveLength(1);
      expect(h.fetch.mock.calls).toHaveLength(beforeLate);
      expect(vi.getTimerCount()).toBe(0);
      expect(
        h.fetch.mock.calls.every(([, input]) => !input?.method || input.method === 'GET')
      ).toBe(true);
    }
  );
  it('settles without AbortController and ignores a timed-out older selection', async () => {
    const payload = emptyPayload();
    payload.active = [
      { id: 'alpha', title: 'Alpha' },
      { id: 'beta', title: 'Beta' },
    ];
    const old = deferred<MockResponse>();
    const h = harness({
      hash: '#alpha',
      withoutAbort: true,
      fetcher: dataFetcher(payload, (path) =>
        path === '/api/progress/alpha' ? old.promise : undefined
      ),
    });
    const mounted = h.window.KyberionProgress.mount();
    await flush();
    await vi.advanceTimersByTimeAsync(20000);
    expect(h.elements['progress-detail-retry'].hidden).toBe(false);
    h.elements['progress-list'].children[1].children[0].fire();
    await flush();
    old.resolve(response(detail('STALE')));
    await mounted;
    await flush();
    expect(h.window.location.hash).toBe('#beta');
    expect(h.elements['progress-detail-status'].textContent).toBe('Details for Beta');
    expect(h.elements['progress-detail'].innerHTML).not.toContain('STALE');
  });
  it.each([401, 403, 404])(
    'clears denied detail status %s before a stalled body',
    async (status) => {
      const payload = emptyPayload();
      payload.active = [{ id: 'alpha', title: 'Alpha' }];
      const json = vi.fn(() => new Promise<never>(() => {}));
      const h = harness({
        hash: '#alpha',
        fetcher: dataFetcher(payload, (path) =>
          path === '/api/progress/alpha' ? Promise.resolve({ ok: false, status, json }) : undefined
        ),
      });
      h.window.KyberionProgress.mount();
      await flush();
      expect(h.elements['progress-list'].children).toHaveLength(0);
      expect(h.noticeText.textContent).toContain('unavailable');
      expect(json).not.toHaveBeenCalled();
      const denied = h.fetch.mock.calls.find(([url]) => url.startsWith('/api/progress/alpha?'))!;
      expect((denied[1]?.signal as AbortSignal).aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(h.elements['progress-detail-retry'].hidden).toBe(true);
    }
  );
  it('does not time out or retry an outstanding verdict POST', async () => {
    const payload = emptyPayload();
    payload.delivered = [
      { id: 'artifact', title: 'Result', can_verdict: true, entry_id: 'inbox-1', status: 'read' },
    ];
    const write = deferred<MockResponse>();
    const h = harness({
      hash: '#artifact',
      fetcher: dataFetcher(payload, (_path, input) =>
        input?.method === 'POST' ? write.promise : undefined
      ),
    });
    await h.window.KyberionProgress.mount();
    const button =
      h.elements['progress-list'].children[0].children[0].querySelector('[data-action="receive"]')!;
    button.fire();
    await vi.advanceTimersByTimeAsync(60000);
    expect(button.disabled).toBe(true);
    expect(h.elements['progress-notice'].hidden).toBe(true);
    const posts = h.fetch.mock.calls.filter(([, input]) => input?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0][1]?.signal).toBeUndefined();
    write.reject(new Error('Unknown outcome'));
    await flush();
    expect(h.noticeText.textContent).toContain('uncertain');
    expect(button.disabled).toBe(true);
  });
});

function correctionPayload() {
  const payload = emptyPayload();
  payload.delivered = ['alpha', 'beta'].map((id) => ({
    id,
    title: id,
    status: 'read',
    can_verdict: true,
    entry_id: 'inbox-' + id,
  }));
  return payload;
}
const rowAt = (h: ReturnType<typeof harness>, index = 0) =>
  h.elements['progress-list'].children[index].children[0];
function editCorrection(h: ReturnType<typeof harness>, text: string) {
  const row = rowAt(h);
  row.querySelector('[data-action="revise"]')!.fire();
  const note = row.querySelector('.progress-revise-note')!;
  note.value = text;
  note.fire('input');
}
describe('Progress correction continuity', () => {
  it('preserves correction draft and form across same-result selection, filters and read refresh without persistent content', async () => {
    const payload = correctionPayload();
    const storage = new Map<string, string>();
    const h = harness({ hash: '#alpha', storage, fetcher: dataFetcher(payload) });
    await h.window.KyberionProgress.mount();
    editCorrection(h, 'Keep this correction');
    rowAt(h).fire();
    expect(rowAt(h).querySelector('.progress-revise-note')?.value).toBe('Keep this correction');
    h.elements['filter-active'].fire();
    h.elements['filter-delivered'].fire();
    expect(rowAt(h).querySelector('.progress-revise-note')?.value).toBe('Keep this correction');
    h.refresh.fire();
    await flush();
    expect(rowAt(h).querySelector('.progress-revise-note')?.value).toBe('Keep this correction');
    expect([...storage.values()].join('')).not.toContain('Keep this correction');
    expect(h.fetch.mock.calls.some(([, input]) => input?.method === 'POST')).toBe(false);
  });
  it('retains correction draft through read failure and recovery but clears it for a newly verified principal', async () => {
    const payload = correctionPayload();
    let fail = false;
    const h = harness({
      hash: '#alpha',
      fetcher: dataFetcher(payload, (path) =>
        path === '/api/progress' && fail ? Promise.reject(new Error('offline')) : undefined
      ),
    });
    await h.window.KyberionProgress.mount();
    editCorrection(h, 'Private correction');
    fail = true;
    h.refresh.fire();
    await flush();
    fail = false;
    h.refresh.fire();
    await flush();
    expect(rowAt(h).querySelector('.progress-revise-note')?.value).toBe('Private correction');
    payload.viewer_scope_id = 'principal-beta';
    h.refresh.fire();
    await flush();
    expect(rowAt(h).querySelector('.progress-revise-note')).toBeNull();
    rowAt(h).querySelector('[data-action="revise"]')!.fire();
    expect(rowAt(h).querySelector('.progress-revise-note')?.value).toBe('');
  });
  it('explicitly discards only the selected entry correction', async () => {
    const h = harness({ hash: '#alpha', fetcher: dataFetcher(correctionPayload()) });
    await h.window.KyberionProgress.mount();
    editCorrection(h, 'Discard me');
    rowAt(h).querySelector('[data-action="discard-correction"]')!.fire();
    expect(rowAt(h).querySelector('.progress-revise-note')).toBeNull();
    rowAt(h).querySelector('[data-action="revise"]')!.fire();
    expect(rowAt(h).querySelector('.progress-revise-note')?.value).toBe('');
  });
  it('labels saved feedback honestly and prepares a scoped ID-only Ask handoff', async () => {
    const payload = emptyPayload();
    payload.done = [
      {
        id: 'artifact-1',
        title: 'Result',
        kind: 'artifact',
        status: 'rejected',
        entry_id: 'inbox-1',
      },
    ];
    const h = harness({ hash: '#artifact-1', fetcher: dataFetcher(payload) });
    await h.window.KyberionProgress.mount();
    const html = rowAt(h).innerHTML;
    expect(html).toContain('Correction feedback recorded');
    expect(h.elements['progress-detail'].innerHTML).toContain('correction=inbox-1');
    expect(html).toContain('correction=inbox-1');
    expect(html).toContain('artifact=artifact-1');
    expect(html).toContain('tenant=alpha');
    expect(html).not.toContain('send=1');
  });
  it('preserves separate entry drafts through Back/Forward and explicit discard', async () => {
    const h = harness({
      search: '?tenant=alpha',
      hash: '#alpha',
      fetcher: dataFetcher(correctionPayload()),
    });
    await h.window.KyberionProgress.mount();
    editCorrection(h, 'Alpha note');
    const beta = rowAt(h, 1);
    beta.querySelector('[data-action="revise"]')!.fire();
    const betaNote = beta.querySelector('.progress-revise-note')!;
    betaNote.value = 'Beta note';
    betaNote.fire('input');
    h.window.location.href = '/progress?tenant=alpha&filter=done';
    h.listeners.popstate();
    h.window.location.href = '/progress?tenant=alpha#alpha';
    h.listeners.popstate();
    await flush();
    expect(rowAt(h).querySelector('.progress-revise-note')?.value).toBe('Alpha note');
    expect(rowAt(h, 1).querySelector('.progress-revise-note')?.value).toBe('Beta note');
    rowAt(h).querySelector('[data-action="discard-correction"]')!.fire();
    expect(rowAt(h, 1).querySelector('.progress-revise-note')?.value).toBe('Beta note');
  });
  it('retains an uncertain correction and prevents duplicate decisions after navigation', async () => {
    const payload = correctionPayload();
    const write = deferred<MockResponse>();
    const h = harness({
      hash: '#alpha',
      fetcher: dataFetcher(payload, (_path, input) =>
        input?.method === 'POST' ? write.promise : undefined
      ),
    });
    await h.window.KyberionProgress.mount();
    editCorrection(h, 'Preserve on lost response');
    rowAt(h)
      .querySelector('.progress-revise-form')!
      .children.find((el) => el.tag === 'button')!
      .fire();
    write.reject(new Error('lost response'));
    await flush();
    rowAt(h).fire();
    await flush();
    expect(rowAt(h).querySelector('.progress-revise-note')?.value).toBe(
      'Preserve on lost response'
    );
    expect(rowAt(h).querySelector('.progress-revise-note')?.disabled).toBe(true);
    rowAt(h).querySelector('[data-action="revise"]')!.fire();
    expect(h.fetch.mock.calls.filter(([, input]) => input?.method === 'POST')).toHaveLength(1);
  });
  it('clears submitted correction only after successful save and records exact note once', async () => {
    const payload = correctionPayload();
    const h = harness({
      hash: '#alpha',
      fetcher: dataFetcher(payload, (_path, input) =>
        input?.method === 'POST' ? Promise.resolve(response({ ok: true })) : undefined
      ),
    });
    await h.window.KyberionProgress.mount();
    editCorrection(h, 'Saved note');
    rowAt(h)
      .querySelector('.progress-revise-form')!
      .children.find((el) => el.tag === 'button')!
      .fire();
    await flush();
    expect(rowAt(h).querySelector('.progress-revise-note')).toBeNull();
    const posts = h.fetch.mock.calls.filter(([, input]) => input?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1]!.body!)).toMatchObject({
      status: 'rejected',
      note: 'Saved note',
    });
  });
});

describe('Progress app-controlled leave confirmation', () => {
  function dialog(h: ReturnType<typeof harness>) {
    return h.renders.filter((r) => r.container === h.elements['progress-leave-dialog']).at(-1)!;
  }
  function choose(h: ReturnType<typeof harness>, choice: string) {
    dialog(h).options!.onAction!({ id: 'progress.leave.choose', payload: { choice } });
  }
  it('keeps exact drafts on Stay and discards only on one current explicit leave', async () => {
    const h = harness({ hash: '#alpha', fetcher: dataFetcher(correctionPayload()) });
    await h.window.KyberionProgress.mount();
    editCorrection(h, 'Keep exact\ntext');
    const proceed = vi.fn();
    h.window.FrontDeskPageLeave.requestLeave(proceed);
    expect(proceed).not.toHaveBeenCalled();
    expect(dialog(h).components[0]).toMatchObject({
      props: {
        open: true,
        choices: [
          { id: 'stay', variant: 'primary' },
          { id: 'leave', variant: 'danger' },
        ],
      },
    });
    choose(h, 'stay');
    await flush();
    expect(rowAt(h).querySelector('.progress-revise-note')!.value).toBe('Keep exact\ntext');
    expect(proceed).not.toHaveBeenCalled();
    h.window.FrontDeskPageLeave.requestLeave(proceed);
    const action = dialog(h).options!.onAction!;
    action({ id: 'progress.leave.choose', payload: { choice: 'leave' } });
    action({ id: 'progress.leave.choose', payload: { choice: 'leave' } });
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls.some(([, input]) => input?.method === 'POST')).toBe(false);
  });
  it('invalidates old intents and Escape keeps current drafts', async () => {
    const h = harness({ hash: '#alpha', fetcher: dataFetcher(correctionPayload()) });
    await h.window.KyberionProgress.mount();
    editCorrection(h, 'Draft');
    const old = vi.fn(),
      next = vi.fn(),
      cancel = vi.fn();
    h.window.FrontDeskPageLeave.requestLeave(old);
    const oldAction = dialog(h).options!.onAction!;
    h.window.FrontDeskPageLeave.requestLeave(next, undefined, cancel);
    oldAction({ id: 'progress.leave.choose', payload: { choice: 'leave' } });
    dialog(h).options!.onAction!({ id: 'progress.leave.cancel' });
    await flush();
    expect(old).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(rowAt(h).querySelector('.progress-revise-note')!.value).toBe('Draft');
  });
  it('guards ordinary query-changing anchors but ignores hash, modified, download and new-tab gestures', async () => {
    const h = harness({
      search: '?tenant=alpha',
      hash: '#alpha',
      fetcher: dataFetcher(correctionPayload()),
    });
    await h.window.KyberionProgress.mount();
    editCorrection(h, 'Draft');
    const fire = (
      href: string,
      extra: Record<string, unknown> = {},
      attrs: Record<string, string> = {}
    ) => {
      const link = {
        target: attrs.target || '',
        hasAttribute: (name: string) => name in attrs,
        getAttribute: () => href,
      };
      const preventDefault = vi.fn();
      h.documentListeners.click({
        target: { closest: () => link } as unknown as Element,
        button: 0,
        preventDefault,
        stopPropagation: vi.fn(),
        ...extra,
      });
      return preventDefault;
    };
    expect(fire('#beta')).not.toHaveBeenCalled();
    expect(fire('#')).not.toHaveBeenCalled();
    expect(fire('/ask', { ctrlKey: true })).not.toHaveBeenCalled();
    expect(fire('/ask', {}, { target: '_blank' })).not.toHaveBeenCalled();
    expect(fire('/file', {}, { download: '' })).not.toHaveBeenCalled();
    expect(fire('mailto:test@example.test')).not.toHaveBeenCalled();
    expect(fire('/progress?tenant=alpha')).toHaveBeenCalledTimes(1);
    choose(h, 'stay');
    await flush();
    expect(fire('/progress?tenant=alpha&filter=done')).toHaveBeenCalledTimes(1);
    expect(h.window.location.assign).not.toHaveBeenCalled();
    choose(h, 'leave');
    expect(h.window.location.assign).toHaveBeenCalledWith(
      'https://studio.example.test/progress?tenant=alpha&filter=done'
    );
  });
  it('keeps protection through read failure and invalidates a dialog for a new verified principal', async () => {
    const payload = correctionPayload();
    let fail = false;
    const h = harness({
      hash: '#alpha',
      fetcher: dataFetcher(payload, (path) =>
        path === '/api/progress' && fail ? Promise.reject(new Error('offline')) : undefined
      ),
    });
    await h.window.KyberionProgress.mount();
    editCorrection(h, 'Secret');
    fail = true;
    h.refresh.fire();
    await flush();
    const proceed = vi.fn();
    h.window.FrontDeskPageLeave.requestLeave(proceed);
    expect(proceed).not.toHaveBeenCalled();
    const stale = dialog(h).options!.onAction!;
    fail = false;
    payload.viewer_scope_id = 'new-principal';
    h.refresh.fire();
    await flush();
    stale({ id: 'progress.leave.choose', payload: { choice: 'leave' } });
    expect(proceed).not.toHaveBeenCalled();
  });
  it('closes safely when a predicate is invalidated before Escape and supersedes a pending context lookup', async () => {
    const h = harness({ hash: '#alpha', fetcher: dataFetcher(correctionPayload()) });
    await h.window.KyberionProgress.mount();
    editCorrection(h, 'Draft');
    let valid = true;
    const proceed = vi.fn(),
      cancel = vi.fn();
    h.window.FrontDeskPageLeave.requestLeave(proceed, () => valid, cancel);
    const action = dialog(h).options!.onAction!;
    valid = false;
    action({ id: 'progress.leave.cancel' });
    await flush();
    expect(dialog(h).components[0]).toMatchObject({ props: { open: false } });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(proceed).not.toHaveBeenCalled();
    const old = h.window.FrontDeskPageLeave.begin();
    const navigate = vi.fn();
    h.window.FrontDeskPageLeave.requestLeave(navigate);
    choose(h, 'leave');
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(old()).toBe(false);
    h.window.FrontDeskPageLeave.requestLeave(proceed, old);
    expect(proceed).not.toHaveBeenCalled();
  });
  it('fails closed and keeps a visible recovery notice when the dialog renderer fails', async () => {
    const h = harness({ hash: '#alpha', fetcher: dataFetcher(correctionPayload()) });
    await h.window.KyberionProgress.mount();
    editCorrection(h, 'Keep me');
    h.window.FrontDeskRail.render = () => {
      throw new Error('renderer unavailable');
    };
    const proceed = vi.fn(),
      cancel = vi.fn();
    h.window.FrontDeskPageLeave.requestLeave(proceed, undefined, cancel);
    await flush();
    expect(proceed).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(h.noticeText.textContent).toContain('could not be displayed');
    expect(rowAt(h).querySelector('.progress-revise-note')!.value).toBe('Keep me');
  });
  it('ignores a late failed close instead of clearing or focusing over a newer dialog', async () => {
    const h = harness({ hash: '#alpha', fetcher: dataFetcher(correctionPayload()) });
    await h.window.KyberionProgress.mount();
    editCorrection(h, 'Draft');
    const render = h.window.FrontDeskRail.render;
    const close = deferred<void>();
    let closes = 0;
    h.window.FrontDeskRail.render = (host, components, options) => {
      render(host, components, options);
      if ((components[0].props as { open: boolean }).open === false && ++closes === 1)
        return close.promise;
    };
    const oldCancel = vi.fn(),
      nextCancel = vi.fn();
    h.window.FrontDeskPageLeave.requestLeave(vi.fn(), undefined, oldCancel);
    choose(h, 'stay');
    h.window.FrontDeskPageLeave.requestLeave(vi.fn(), undefined, nextCancel);
    close.reject(new Error('late close failure'));
    await flush();
    expect(oldCancel).not.toHaveBeenCalled();
    expect(dialog(h).components[0]).toMatchObject({ props: { open: true } });
    choose(h, 'stay');
    await flush();
    expect(nextCancel).toHaveBeenCalledTimes(1);
    expect(rowAt(h).querySelector('.progress-revise-note')!.value).toBe('Draft');
  });
  it('fences old context lookups even when a draft was already discarded before clean anchor navigation', async () => {
    const h = harness({ hash: '#alpha', fetcher: dataFetcher(correctionPayload()) });
    await h.window.KyberionProgress.mount();
    editCorrection(h, 'Draft');
    const old = h.window.FrontDeskPageLeave.begin();
    rowAt(h).querySelector('[data-action="discard-correction"]')!.fire();
    const link = { target: '', hasAttribute: () => false, getAttribute: () => '/ask' };
    const preventDefault = vi.fn();
    h.documentListeners.click({
      target: { closest: () => link } as unknown as Element,
      button: 0,
      preventDefault,
      stopPropagation: vi.fn(),
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(old()).toBe(false);
  });
  it('marks actual delivered and historical artifact links as downloads', async () => {
    const payload = correctionPayload();
    payload.delivered[0].downloadable = true;
    payload.done = [{ id: 'done-file', kind: 'artifact', status: 'accepted', downloadable: true }];
    const h = harness({ hash: '#alpha', fetcher: dataFetcher(payload) });
    await h.window.KyberionProgress.mount();
    expect(rowAt(h).innerHTML).toMatch(/<a[^>]*download[^>]*href="[^"]*api\/artifacts\/alpha/);
    h.elements['filter-done'].fire();
    expect(rowAt(h).innerHTML).toMatch(/<a[^>]*download[^>]*href="[^"]*api\/artifacts\/done-file/);
  });
  it('prompts for pending and uncertain decisions without draft text and preserves locks when leaving', async () => {
    const payload = correctionPayload();
    const write = deferred<MockResponse>();
    const h = harness({
      hash: '#alpha',
      fetcher: dataFetcher(payload, (_path, input) =>
        input?.method === 'POST' ? write.promise : undefined
      ),
    });
    await h.window.KyberionProgress.mount();
    rowAt(h).querySelector('[data-action="receive"]')!.fire();
    const proceed = vi.fn();
    h.window.FrontDeskPageLeave.requestLeave(proceed);
    expect(dialog(h).components[0]).toMatchObject({
      props: { message: texts['front_desk:progress_leave_pending'] },
    });
    const oldAction = dialog(h).options!.onAction!;
    write.resolve(response({ ok: false }, false));
    await flush();
    expect(dialog(h).components[0]).toMatchObject({
      props: { message: texts['front_desk:progress_leave_uncertain'] },
    });
    oldAction({ id: 'progress.leave.choose', payload: { choice: 'leave' } });
    expect(proceed).not.toHaveBeenCalled();
    choose(h, 'leave');
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(
      h.window.sessionStorage.getItem('front-desk.progress.uncertain.principal-alpha')
    ).toContain('inbox-alpha');
    expect(h.fetch.mock.calls.filter(([, input]) => input?.method === 'POST')).toHaveLength(1);
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, StrictMode } from 'react';
import {
  installFakeDom,
  fireEvent,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { storeFrontDeskToken } from '../src/lib/front-desk-auth-token';
import { TENANT_CHANGED_EVENT } from '../src/lib/tenant-context';

// Outcome-preview request ownership in the real `/inbox` page (MSN-SHELL-IA):
// the decision queue moved from `/` to `/inbox`, which reads the unified
// needs-you API. The preview invariants are unchanged.

const watch = vi.hoisted(() => ({
  onSummary: (_event: MessageEvent) => {},
  refresh: async (_signal: AbortSignal) => {},
}));
vi.mock('../src/lib/summary-watch', () => ({
  startSummaryWatch: (input: {
    refresh: (signal: AbortSignal) => Promise<void>;
    onSummary: (event: MessageEvent) => void;
  }) => {
    watch.onSummary = input.onSummary;
    watch.refresh = input.refresh;
    const controller = new AbortController();
    void input.refresh(controller.signal);
    return () => controller.abort();
  },
}));
vi.mock('../src/lib/use-concierge-i18n', () => ({
  useConciergeI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
vi.mock('../src/lib/i18n', () => ({
  frontDeskText: (key: string) => key,
  conciergeText: (key: string) => key,
}));
// The inbox reads its filters from the URL (`?reason=&overdue=`).
const nav = vi.hoisted(() => ({ query: '' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
  usePathname: () => '/inbox',
}));
vi.mock('../src/app/outcome-files', () => ({ OutcomeFiles: () => null }));
vi.mock('../src/app/review-checkin', () => ({ ReviewCheckin: () => null }));
import InboxPage from '../src/app/inbox/page';

interface OutcomeRecord {
  entry_id: string;
  title: string;
  summary: string;
  artifact_paths: string[];
  status: string;
  updated_at: string;
}
interface QueueState {
  outcome_feed: OutcomeRecord[];
  approval_tenants: string[];
}
const item = (entry_id: string): OutcomeRecord => ({
  entry_id,
  title: 'Outcome ' + entry_id,
  summary: 'Review',
  artifact_paths: [entry_id + '.txt'],
  status: 'unread',
  updated_at: '2026-10-10T00:00:00Z',
});
const summary = (): QueueState => ({ outcome_feed: [item('A'), item('B')], approval_tenants: [] });
const needsYouItems = (state: QueueState) => [
  ...state.approval_tenants.map((tenant) => ({
    id: 'approval:inbox/' + tenant,
    reason: 'approval',
    title: { text: tenant },
    requester: { label: { text: 'agent' }, agent: true },
    tenant_slug: tenant,
    waiting_since: '2026-10-10T00:00:00Z',
    overdue: false,
    actions: ['approve', 'reject', 'later'],
    group_size: 1,
    approval: {
      id: tenant,
      tenant_slug: tenant,
      title: tenant,
      channel: 'email',
      storage_channel: 'inbox',
      reason: 'Review',
      requested_at: '2026-10-10T00:00:00Z',
    },
  })),
  ...state.outcome_feed.map((outcome) => ({
    id: 'review:' + outcome.entry_id,
    reason: 'review',
    title: { text: outcome.title },
    requester: { label: { text: 'agent' }, agent: true },
    waiting_since: outcome.updated_at,
    overdue: false,
    actions: ['approve', 'request_changes', 'reject', 'later', 'open'],
    group_size: 1,
    outcome,
  })),
];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const preview = (id: string, text = 'content-' + id) =>
  json({
    ok: true,
    preview: {
      entry_id: id,
      total: 1,
      shown: 1,
      files: [{ name: id + '.txt', kind: 'text', content: text }],
    },
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const PREVIEW_URL = /^\/api\/outcomes\/([^/]+)\/preview$/;
let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
let unmount: (() => void) | undefined;
let token: string | null = null;
let storageFails = false;
const history = { pushState: vi.fn(), replaceState: vi.fn(), back: vi.fn(), forward: vi.fn() };
beforeAll(async () => {
  dom = installFakeDom({
    history,
    sessionStorage: {
      getItem: () => {
        if (storageFails) throw Error('unavailable');
        return token;
      },
      setItem: (_key: string, value: string) => {
        token = value;
      },
      removeItem: () => {
        token = null;
      },
    },
    localStorage: { getItem: () => null, setItem: vi.fn() },
  });
  client = await import('react-dom/client');
});
beforeEach(() => {
  token = null;
  storageFails = false;
  nav.query = '';
  vi.clearAllMocks();
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(() => dom.restore());
const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
function mount(strict = false, initial = summary()) {
  let summaryFailed = false;
  let state = initial;
  const requests: Array<
    ReturnType<typeof deferred<Response>> & { id: string; signal?: AbortSignal | null }
  > = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/v1/needs-you/summary'))
        return summaryFailed
          ? json({ ok: false }, 500)
          : json({
              ok: true,
              total: needsYouItems(state).length,
              overdue: 0,
              byReason: {
                approval: state.approval_tenants.length,
                decision: 0,
                review: state.outcome_feed.length,
                knowledge: 0,
                clarification: 0,
                failure: 0,
              },
            });
      if (url.startsWith('/api/v1/needs-you')) {
        if (summaryFailed) return json({ ok: false }, 500);
        const reason = new URLSearchParams(url.split('?')[1] ?? '').get('reason');
        const items = needsYouItems(state).filter((entry) => !reason || entry.reason === reason);
        return json({ ok: true, items, total: items.length });
      }
      const match = PREVIEW_URL.test(url) ? url.match(PREVIEW_URL) : null;
      if (match) {
        const pending = deferred<Response>();
        requests.push({ ...pending, id: decodeURIComponent(match[1]), signal: init?.signal });
        // Deliberately ignore abort: stale delivery must be safe even with an uncooperative request.
        return pending.promise;
      }
      return json({ ok: false }, 404);
    })
  );
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  const render = () =>
    act(() =>
      root.render(
        strict
          ? createElement(StrictMode, null, createElement(InboxPage))
          : createElement(InboxPage)
      )
    );
  render();
  unmount = () => act(() => root.unmount());
  const card = (id: string) => container.querySelector('[id="inbox-review:' + id + '"]');
  const control = (id: string, label?: string) => {
    const found = card(id)
      ?.querySelectorAll('button')
      .find((button) =>
        label
          ? button.textContent === label
          : ['action_open', 'home.preview_hide'].includes(button.textContent)
      );
    if (!found) throw Error('Missing outcome control ' + id + ' ' + label);
    return found;
  };
  const click = (id: string, label?: string) =>
    act(() => {
      fireEvent(control(id, label), 'click');
    });
  // A summary event makes the page re-read the queue; deliver it and let the read land.
  const update = async (value: QueueState) => {
    state = value;
    act(() => watch.onSummary({ data: '{}' } as MessageEvent));
    await flush();
  };
  const failSummary = async () => {
    summaryFailed = true;
    await act(() => watch.refresh(new AbortController().signal));
  };
  const recoverSummary = () => {
    summaryFailed = false;
  };
  // Filters live in the URL: change the query and re-render.
  const filter = (query: string) => {
    nav.query = query;
    render();
  };
  return {
    container,
    requests,
    card,
    control,
    click,
    update,
    render,
    failSummary,
    recoverSummary,
    filter,
  };
}

describe('outcome preview request ownership in the real page', () => {
  it.each(['A-first', 'B-first'])('keeps B selected when completion order is %s', async (order) => {
    const m = mount();
    await flush();
    m.click('A');
    m.click('B');
    expect(m.control('B').textContent).toBe('home.preview_hide');
    expect(m.requests[0].signal?.aborted).toBe(true);
    if (order === 'A-first') {
      m.requests[0].resolve(preview('A'));
      await flush();
      expect(m.container.textContent).not.toContain('content-A');
      expect(m.card('B')?.querySelector('[aria-busy="true"]')).toBeTruthy();
      m.requests[1].resolve(preview('B'));
    } else {
      m.requests[1].resolve(preview('B'));
      await flush();
      m.requests[0].resolve(preview('A'));
    }
    await flush();
    expect(m.container.textContent).toContain('content-B');
    expect(m.container.textContent).not.toContain('content-A');
  });
  it('does not let an old failure clear B loading or display an error', async () => {
    const m = mount();
    await flush();
    m.click('A');
    m.click('B');
    m.requests[0].reject(Error('old failure'));
    await flush();
    expect(m.container.textContent).not.toContain('home.preview_error');
    expect(m.card('B')?.querySelector('[aria-busy="true"]')).toBeTruthy();
    m.requests[1].resolve(preview('B'));
    await flush();
    expect(m.container.textContent).toContain('content-B');
  });
  it('closes while pending, reopens the same entry and rejects its old body', async () => {
    const m = mount();
    await flush();
    m.click('A');
    const body = deferred<unknown>();
    const response = preview('A');
    Object.defineProperty(response, 'json', { configurable: true, value: () => body.promise });
    m.requests[0].resolve(response);
    m.click('A');
    m.click('A');
    expect(m.requests).toHaveLength(2);
    body.resolve({
      ok: true,
      preview: {
        entry_id: 'A',
        total: 1,
        shown: 1,
        files: [{ name: 'A.txt', kind: 'text', content: 'old-body' }],
      },
    });
    await flush();
    expect(m.container.textContent).not.toContain('old-body');
    m.requests[1].resolve(preview('A', 'fresh-body'));
    await flush();
    expect(m.container.textContent).toContain('fresh-body');
  });
  it('handles two clicks before a React commit as open then close', async () => {
    const m = mount();
    await flush();
    const button = m.control('A');
    act(() => {
      fireEvent(button, 'click');
      fireEvent(button, 'click');
    });
    expect(m.requests).toHaveLength(1);
    expect(m.requests[0].signal?.aborted).toBe(true);
    m.requests[0].resolve(preview('A'));
    await flush();
    expect(m.container.textContent).not.toContain('content-A');
  });
  it.each(['wrong-id', 'malformed', 'http-error'])(
    'rejects the current %s receipt',
    async (kind) => {
      const m = mount();
      await flush();
      m.click('A');
      m.requests[0].resolve(
        kind === 'wrong-id'
          ? preview('B')
          : kind === 'malformed'
            ? json({ ok: true })
            : json({ ok: false }, 500)
      );
      await flush();
      expect(m.container.textContent).toContain('home.preview_error');
      expect(m.container.textContent).not.toContain('content-B');
      m.click('A');
      m.click('A');
      m.requests[1].resolve(preview('A'));
      await flush();
      expect(m.container.textContent).toContain('content-A');
      expect(m.container.textContent).not.toContain('home.preview_error');
    }
  );
  it.each(['revision', 'artifacts', 'removal', 'defer'])(
    'invalidates on selected outcome %s',
    async (change) => {
      const m = mount();
      await flush();
      m.click('A');
      const next = summary();
      if (change === 'revision') next.outcome_feed[0].updated_at = '2026-10-10T01:00:00Z';
      if (change === 'artifacts') next.outcome_feed[0].artifact_paths = ['replacement.txt'];
      if (change === 'removal') next.outcome_feed.shift();
      if (change === 'defer') m.click('A', 'decide_later');
      else await m.update(next);
      expect(m.requests[0].signal?.aborted).toBe(true);
      m.requests[0].resolve(preview('A'));
      await flush();
      expect(m.container.textContent).not.toContain('content-A');
    }
  );
  it('preserves a preview across equivalent queue snapshots', async () => {
    const m = mount();
    await flush();
    m.click('A');
    m.requests[0].resolve(preview('A'));
    await flush();
    await m.update(summary());
    expect(m.container.textContent).toContain('content-A');
    expect(m.requests).toHaveLength(1);
  });
  it.each(['pagehide', 'popstate', TENANT_CHANGED_EVENT])(
    'invalidates %s without modifying browser history',
    async (event) => {
      const m = mount();
      await flush();
      m.click('A');
      act(() => fireEvent(dom.windowEvents, event, { detail: { tenant: 'alpha' } }));
      expect(m.requests[0].signal?.aborted).toBe(true);
      m.requests[0].resolve(preview('A'));
      await flush();
      expect(m.container.textContent).not.toContain('content-A');
      for (const method of Object.values(history)) expect(method).not.toHaveBeenCalled();
    }
  );
  it.each(['token', 'same-token-revision', 'storage-failure'])(
    'drops a completion after %s changes',
    async (change) => {
      token = 'initial-token';
      const m = mount();
      await flush();
      m.click('A');
      if (change === 'token') token = 'different-token';
      else if (change === 'same-token-revision') storeFrontDeskToken('initial-token');
      else storageFails = true;
      m.requests[0].resolve(preview('A'));
      await flush();
      expect(m.container.textContent).not.toContain('content-A');
      expect(m.control('A').textContent).toBe('action_open');
      expect(m.container.textContent).not.toContain('home.preview_error');
    }
  );
  it('aborts on unmount and remains usable under StrictMode lifecycle replay', async () => {
    const m = mount(true);
    await flush();
    m.click('A');
    m.requests[0].resolve(preview('A'));
    await flush();
    expect(m.container.textContent).toContain('content-A');
    m.click('B');
    unmount?.();
    unmount = undefined;
    expect(m.requests[1].signal?.aborted).toBe(true);
    m.requests[1].resolve(preview('B'));
    await flush();
    expect(m.container.textContent).toBe('');
  });
});

it('clears completed content immediately when selecting another preview', async () => {
  const m = mount();
  await flush();
  m.click('A');
  m.requests[0].resolve(preview('A'));
  await flush();
  m.click('B');
  expect(m.container.textContent).not.toContain('content-A');
  expect(m.card('B')?.querySelector('[aria-busy="true"]')).toBeTruthy();
});
it('clears a pending preview when the reason filter changes', async () => {
  const initial = summary();
  initial.approval_tenants = ['alpha'];
  const m = mount(false, initial);
  await flush();
  m.click('A');
  m.filter('reason=approval');
  await flush();
  expect(m.requests[0].signal?.aborted).toBe(true);
  m.requests[0].resolve(preview('A'));
  await flush();
  expect(m.container.textContent).not.toContain('content-A');
  m.filter('');
  await flush();
  expect(m.container.textContent).not.toContain('content-A');
});
it('drops a preview when a failed read hides the queue, including after recovery', async () => {
  const m = mount();
  await flush();
  m.click('A');
  await m.failSummary();
  expect(m.container.textContent).toContain('ia_inbox_load_error');
  expect(m.card('A')).toBeNull();
  expect(m.requests[0].signal?.aborted).toBe(true);
  m.requests[0].resolve(preview('A'));
  await flush();
  m.recoverSummary();
  await m.update(summary());
  expect(m.container.textContent).not.toContain('content-A');
  expect(m.control('A').textContent).toBe('action_open');
});
it('recovers the decision queue through a read-only retry without stale preview actions', async () => {
  const m = mount();
  await flush();
  await m.failSummary();
  expect(m.card('A')).toBeNull();
  const retry = m.container
    .querySelectorAll('button')
    .find((button) => button.textContent === 'home.load_retry');
  expect(retry).toBeDefined();
  m.recoverSummary();
  await act(async () => fireEvent(retry!, 'click'));
  await flush();
  expect(m.card('A')).not.toBeNull();
  expect(m.control('A').textContent).toBe('action_open');
  expect(m.container.textContent).not.toContain('ia_inbox_load_error');
});
it('offers an explicit ask action when nothing is waiting', async () => {
  const empty = summary();
  empty.outcome_feed = [];
  const m = mount(false, empty);
  await flush();
  const opened = vi.fn();
  const previous = Object.getOwnPropertyDescriptor(window, 'dispatchEvent');
  Object.defineProperty(window, 'dispatchEvent', { configurable: true, value: opened });
  try {
    const ask = m.container
      .querySelectorAll('button')
      .find((button) => button.textContent === 'home.ask_start');
    expect(ask).toBeDefined();
    act(() => fireEvent(ask!, 'click'));
    expect(opened).toHaveBeenCalledOnce();
    expect(opened.mock.calls[0][0].type).toBe('concierge:open-dock');
  } finally {
    if (previous) Object.defineProperty(window, 'dispatchEvent', previous);
    else Reflect.deleteProperty(window, 'dispatchEvent');
  }
});
it('drops data when authentication changes during response-body consumption', async () => {
  token = 'initial';
  const m = mount();
  await flush();
  m.click('A');
  const body = deferred<unknown>();
  const response = preview('A');
  Object.defineProperty(response, 'json', { configurable: true, value: () => body.promise });
  m.requests[0].resolve(response);
  await flush();
  token = 'replacement';
  body.resolve({
    ok: true,
    preview: {
      entry_id: 'A',
      total: 1,
      shown: 1,
      files: [{ name: 'private', kind: 'text', content: 'stale-private' }],
    },
  });
  await flush();
  expect(m.container.textContent).not.toContain('stale-private');
  expect(m.control('A').textContent).toBe('action_open');
});
it('bounds an uncooperative request and rejects its success after timeout and retry', async () => {
  vi.useFakeTimers();
  const m = mount();
  await flush();
  m.click('A');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(m.requests[0].signal?.aborted).toBe(true);
  expect(m.container.textContent).toContain('home.preview_error');
  expect(m.card('A')?.querySelector('[aria-busy="true"]')).toBeNull();
  m.click('A');
  m.click('A');
  m.requests[1].resolve(preview('A', 'retried-content'));
  await flush();
  m.requests[0].resolve(preview('A', 'expired-content'));
  await flush();
  expect(m.container.textContent).toContain('retried-content');
  expect(m.container.textContent).not.toContain('expired-content');
});
it('does not leave a completed deadline timer or show a later false timeout', async () => {
  vi.useFakeTimers();
  const m = mount();
  await flush();
  m.click('A');
  m.requests[0].resolve(preview('A'));
  await flush();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_001);
  });
  expect(m.container.textContent).toContain('content-A');
  expect(m.container.textContent).not.toContain('home.preview_error');
});
it('rejects invalid JSON without reopening a dismissed panel', async () => {
  const m = mount();
  await flush();
  m.click('A');
  m.requests[0].resolve(
    new Response('{invalid', { headers: { 'content-type': 'application/json' } })
  );
  await flush();
  expect(m.container.textContent).toContain('home.preview_error');
  m.click('A');
  expect(m.container.textContent).not.toContain('home.preview_error');
});
it('clears a restored BFCache preview without writing history or re-requesting data', async () => {
  const m = mount();
  await flush();
  m.click('A');
  m.requests[0].resolve(preview('A'));
  await flush();
  act(() => fireEvent(dom.windowEvents, 'pageshow', { persisted: true }));
  expect(m.container.textContent).not.toContain('content-A');
  expect(m.requests).toHaveLength(1);
  for (const method of Object.values(history)) expect(method).not.toHaveBeenCalled();
});

it('explains unavailable credential storage without dispatching a fallback request', async () => {
  const m = mount();
  await flush();
  storageFails = true;
  m.click('A');
  expect(m.requests).toHaveLength(0);
  expect(m.container.textContent).toContain('home.preview_error');
  expect(m.control('A').textContent).toBe('home.preview_hide');
  m.click('A');
  expect(m.container.textContent).not.toContain('home.preview_error');
  storageFails = false;
  m.click('A');
  expect(m.requests).toHaveLength(1);
  m.requests[0].resolve(preview('A'));
  await flush();
  expect(m.container.textContent).toContain('content-A');
});

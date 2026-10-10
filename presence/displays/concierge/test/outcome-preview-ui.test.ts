import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, StrictMode } from 'react';
import {
  installFakeDom,
  fireEvent,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import type { ConciergeSummary } from '../src/lib/summary-event';
import { storeFrontDeskToken } from '../src/lib/front-desk-auth-token';
import { TENANT_CHANGED_EVENT } from '../src/lib/tenant-context';

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
vi.mock('../src/lib/i18n', () => ({ frontDeskText: (key: string) => key }));
vi.mock('../src/app/outcome-files', () => ({ OutcomeFiles: () => null }));
vi.mock('../src/app/review-checkin', () => ({ ReviewCheckin: () => null }));
import ConciergePage from '../src/app/page';

const item = (entry_id: string) => ({
  entry_id,
  title: 'Outcome ' + entry_id,
  summary: 'Review',
  artifact_paths: [entry_id + '.txt'],
  status: 'unread',
  updated_at: '2026-10-10T00:00:00Z',
});
const summary = (): ConciergeSummary => ({
  generated_at: '2026-10-10T00:00:00Z',
  briefing: {
    sentence_ja: 'Ready',
    counts: { active_missions: 0, pending_approvals: 0, unread_outcomes: 2, exceptions: 0 },
  },
  intent_inbox: [],
  approval_queue: [],
  outcome_feed: [item('A'), item('B')],
  exception_feed: [],
});
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
    await Promise.resolve();
    await Promise.resolve();
  });
function mount(strict = false, initial = summary()) {
  let summaryFailed = false;
  const requests: Array<
    ReturnType<typeof deferred<Response>> & { id: string; signal?: AbortSignal | null }
  > = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/summary')
        return summaryFailed ? json({ ok: false }, 500) : json({ ok: true, summary: initial });
      const match = /^\/api\/outcomes\/([^/]+)\/preview$/.exec(url);
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
          ? createElement(StrictMode, null, createElement(ConciergePage))
          : createElement(ConciergePage)
      )
    );
  render();
  unmount = () => act(() => root.unmount());
  const card = (id: string) => container.querySelector('[id="decide-outcome-' + id + '"]');
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
  const update = (value: ConciergeSummary) =>
    act(() => watch.onSummary({ data: JSON.stringify(value) } as MessageEvent));
  const failSummary = async () => {
    summaryFailed = true;
    await act(() => watch.refresh(new AbortController().signal));
  };
  const tab = (id: string) =>
    act(() => {
      const button = container.querySelector('[data-tab-id="' + id + '"]');
      if (!button) throw Error('Missing tab ' + id);
      fireEvent(button, 'click');
    });
  return { container, requests, card, control, click, update, render, failSummary, tab };
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
    await flush();
    expect(m.control('A').getAttribute('disabled')).toBeNull();
    m.click('A');
    expect(m.control('A').textContent).toBe('action_open');
    m.click('A');
    expect(m.requests).toHaveLength(2);
    body.resolve({
      ok: true,
      preview: {
        entry_id: 'A',
        total: 1,
        shown: 1,
        files: [{ name: 'old', kind: 'text', content: 'old-body' }],
      },
    });
    await flush();
    expect(m.container.textContent).not.toContain('old-body');
    m.requests[1].resolve(preview('A', 'new-body'));
    await flush();
    expect(m.container.textContent).toContain('new-body');
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
      else m.update(next);
      expect(m.requests[0].signal?.aborted).toBe(true);
      m.requests[0].resolve(preview('A'));
      await flush();
      expect(m.container.textContent).not.toContain('content-A');
    }
  );
  it('preserves a preview across equivalent summary snapshots', async () => {
    const m = mount();
    await flush();
    m.click('A');
    m.requests[0].resolve(preview('A'));
    await flush();
    const next = summary();
    next.generated_at = '2026-10-10T01:00:00Z';
    m.update(next);
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

const approval = (tenant_slug: string): ConciergeSummary['approval_queue'][number] => ({
  id: tenant_slug,
  tenant_slug,
  title: tenant_slug,
  channel: 'email',
  storage_channel: 'inbox',
  reason: 'Review',
  requested_at: '2026-10-10T00:00:00Z',
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
it.each(['kind', 'tenant'])(
  'clears a pending preview when the %s filter changes',
  async (filter) => {
    const initial = summary();
    initial.approval_queue = [approval('alpha'), approval('beta')];
    const m = mount(false, initial);
    await flush();
    m.click('A');
    m.tab(filter === 'kind' ? 'approval' : 'alpha');
    expect(m.requests[0].signal?.aborted).toBe(true);
    m.requests[0].resolve(preview('A'));
    await flush();
    expect(m.container.textContent).not.toContain('content-A');
    m.tab('all');
    expect(m.container.textContent).not.toContain('content-A');
  }
);
it('invalidates a preview when a refreshed queue changes the effective tenant filter', async () => {
  const initial = summary();
  initial.approval_queue = [approval('alpha')];
  const m = mount(false, initial);
  await flush();
  act(() => fireEvent(dom.windowEvents, TENANT_CHANGED_EVENT, { detail: { tenant: 'alpha' } }));
  m.click('A');
  const next = summary();
  next.approval_queue = [approval('alpha'), approval('beta')];
  m.update(next);
  expect(m.card('A')).toBeNull();
  expect(m.requests[0].signal?.aborted).toBe(true);
  m.requests[0].resolve(preview('A'));
  await flush();
  expect(m.container.textContent).not.toContain('content-A');
});
it('drops a preview when a failed summary hides the queue, including after recovery', async () => {
  const m = mount();
  await flush();
  m.click('A');
  await m.failSummary();
  expect(m.container.textContent).toContain('home.load_error');
  expect(m.requests[0].signal?.aborted).toBe(true);
  m.requests[0].resolve(preview('A'));
  await flush();
  m.update(summary());
  expect(m.container.textContent).not.toContain('content-A');
  expect(m.control('A').textContent).toBe('action_open');
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

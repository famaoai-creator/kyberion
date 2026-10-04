import { describe, it, expect, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { safeReadFile } from '@agent/core/secure-io';

class Element {
  value = '';
  innerHTML = '';
  textContent = '';
  disabled = false;
  attributes: Record<string, string> = {};
  listeners: Record<string, (event: { preventDefault: () => void }) => void> = {};
  classList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() };
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  addEventListener(name: string, handler: (event: { preventDefault: () => void }) => void) {
    this.listeners[name] = handler;
  }
  fire(name: string) {
    this.listeners[name]?.({ preventDefault() {} });
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const session = 'concierge-' + 'a'.repeat(64);
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
});
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
function harness(
  options: {
    storage?: Map<string, string>;
    ready?: Promise<unknown>;
    post?: (body: Record<string, unknown>) => Promise<ReturnType<typeof response>>;
    history?: Record<string, unknown>;
    historyStatus?: number;
  } = {}
) {
  const elements = new Map(
    [
      'ask-form',
      'ask-input',
      'ask-send',
      'turns',
      'ask-empty',
      'conversation-status',
      'conversation-reload',
      'conversation-legacy',
      'conversation-legacy-turns',
    ].map((id) => [id, new Element()])
  );
  const storage = options.storage ?? new Map<string, string>();
  const location = {
    href: 'http://localhost/ask?tenant=alpha',
    origin: 'http://localhost',
    pathname: '/ask',
    search: '?tenant=alpha',
    hash: '',
  };
  const scopedUrl = (path: string) => {
    const url = new URL(path, location.href);
    url.searchParams.set('tenant', 'alpha');
    return url.origin === location.origin ? url.pathname + url.search : url.href;
  };
  const window = {
    location,
    crypto: { randomUUID },
    history: { state: null, replaceState: vi.fn() },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    KyberionPrefs: { locale: () => 'en', tenant: () => 'alpha', scopedUrl },
    FrontDeskRail: { ready: options.ready ?? Promise.resolve() },
    KyberionAsk: undefined as undefined | { mount: () => void },
  };
  const texts = new Proxy({} as Record<string, string>, { get: (_target, key) => String(key) });
  const fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST')
      return options.post
        ? options.post(JSON.parse(init.body!))
        : response({ ok: true, reply: 'Done', mode: 'orchestrator' });
    if (url.startsWith('/api/ask-vocabulary')) return response({ ok: true, texts });
    if (url.startsWith('/api/progress')) return response({ ok: true, active: [] });
    if (url.startsWith('/api/conversation'))
      return response(
        { ok: true, sessionId: session, messages: [], pending: 0, ...options.history },
        options.historyStatus ?? 200
      );
    throw new Error('unexpected ' + url);
  });
  const document = {
    documentElement: { getAttribute: () => 'en' },
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  runInNewContext(
    String(safeReadFile('presence/displays/presence-studio/static/ask.js', { encoding: 'utf8' })),
    { window, document, fetch, navigator: {}, URL, URLSearchParams, crypto: window.crypto, console }
  );
  window.KyberionAsk!.mount();
  return {
    elements,
    storage,
    fetch,
    window,
    input: elements.get('ask-input')!,
    form: elements.get('ask-form')!,
  };
}
describe('Ask durable browser behavior (DOM doubles, no visual claim)', () => {
  it('waits for scope readiness and restores display-only server history', async () => {
    const ready = deferred<void>();
    const h = harness({
      ready: ready.promise,
      history: {
        messages: [
          { id: 'old-user', role: 'user', text: 'Old question' },
          {
            id: 'old-secretary',
            role: 'secretary',
            text: 'Old answer',
            next_actions: [{ label: 'Execute again' }],
          },
        ],
      },
    });
    await flush();
    expect(h.fetch).not.toHaveBeenCalled();
    ready.resolve();
    await flush();
    expect(h.fetch).toHaveBeenCalledWith('/api/conversation?tenant=alpha', { cache: 'no-store' });
    expect(h.elements.get('turns')!.innerHTML).toContain('Old answer');
    expect(h.elements.get('turns')!.innerHTML).not.toContain('Execute again');
  });
  it('keeps editable draft on uncertain failure and reuses the request across reload', async () => {
    const storage = new Map<string, string>();
    const first = harness({
      storage,
      post: async () => response({ ok: false, mode: 'unavailable', retry_safe: false }, 503),
    });
    await flush();
    first.input.value = 'Do work';
    first.input.fire('input');
    first.form.fire('submit');
    await flush();
    expect(first.input.value).toBe('Do work');
    expect(first.input.disabled).toBe(false);
    expect(first.elements.get('turns')!.innerHTML).not.toContain('unavailable');
    expect(first.elements.get('conversation-status')!.innerHTML).toContain('dock.history.pending');
    const firstPost = first.fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    const firstId = JSON.parse(firstPost[1]!.body!).request_id;
    const second = harness({ storage });
    await flush();
    expect(second.input.value).toBe('Do work');
    second.form.fire('submit');
    await flush();
    const secondPost = second.fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(secondPost[1]!.body!)).toMatchObject({
      request_id: firstId,
      conversation_id: session,
      tenant: 'alpha',
    });
  });
  it('prevents repeated submission and does not erase newer draft when reply arrives', async () => {
    const pending = deferred<ReturnType<typeof response>>();
    const h = harness({ post: () => pending.promise });
    await flush();
    h.input.value = 'First request';
    h.form.fire('submit');
    h.form.fire('submit');
    await flush();
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    h.input.value = 'Next draft';
    h.input.fire('input');
    pending.resolve(response({ ok: true, reply: 'First result', mode: 'orchestrator' }));
    await flush();
    expect(h.input.value).toBe('Next draft');
    expect(h.elements.get('turns')!.innerHTML).toContain('First result');
  });
  it('keeps legacy history local and read-only instead of importing or replaying it', async () => {
    const raw = JSON.stringify([
      { role: 'companion', text: '<script>unsafe</script>', next_actions: [{ label: 'Run now' }] },
    ]);
    const storage = new Map([
      ['kyberion.ask.turns', raw],
      ['kyberion.ask.session_id', 'legacy-tab'],
    ]);
    const h = harness({ storage });
    await flush();
    expect(storage.get('kyberion.ask.turns')).toBe(raw);
    expect(storage.get('kyberion.ask.session_id')).toBe('legacy-tab');
    expect(h.elements.get('conversation-legacy-turns')!.innerHTML).toContain('&lt;script&gt;');
    expect(h.elements.get('turns')!.innerHTML).not.toContain('unsafe');
    expect(h.fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });
});

it('does not send or overwrite unverified saved request state after storage read failure', async () => {
  const storage = new Map([['kyberion.ask.draft.' + session + '.request', '{corrupt']]);
  const h = harness({ storage });
  h.window.sessionStorage.getItem = () => {
    throw new Error('read blocked');
  };
  await flush();
  h.input.value = 'Do work';
  h.form.fire('submit');
  await flush();
  expect(h.fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  expect(storage.get('kyberion.ask.draft.' + session + '.request')).toBe('{corrupt');
  expect(h.elements.get('conversation-status')!.innerHTML).toContain(
    'conversation_storage_required'
  );
});
it('keeps draft and refuses execution when retry identity cannot be saved', async () => {
  const h = harness();
  await flush();
  h.window.sessionStorage.setItem = () => {
    throw new Error('write blocked');
  };
  h.input.value = 'Do work';
  h.form.fire('submit');
  await flush();
  expect(h.input.value).toBe('Do work');
  expect(h.fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
});
it.each(['false', 'null', '[]', '{}', ''])(
  'retains invalid request metadata without executing (%s)',
  async (raw) => {
    const key = 'kyberion.ask.draft.' + session + '.request';
    const storage = new Map([[key, raw]]);
    const h = harness({ storage });
    await flush();
    h.input.value = 'Do work';
    h.form.fire('submit');
    await flush();
    expect(storage.get(key)).toBe(raw);
    expect(h.fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  }
);
it('explains local action access without inventing a reply or retrying', async () => {
  const h = harness({ historyStatus: 403 });
  await flush();
  expect(h.elements.get('conversation-status')!.innerHTML).toContain(
    'conversation_access_required'
  );
  expect(h.elements.get('ask-send')!.disabled).toBe(true);
});

it.each([
  'conversation_not_started',
  'conversation_scope_selection_required',
  'conversation_capability_unsupported',
])('shows actionable %s while keeping the draft', async (error) => {
  const h = harness({
    post: async () =>
      response(
        { ok: false, error, retry_safe: error !== 'conversation_capability_unsupported' },
        error === 'conversation_capability_unsupported' ? 422 : 409
      ),
  });
  await flush();
  h.input.value = 'Keep my draft';
  h.form.fire('submit');
  await flush();
  expect(h.input.value).toBe('Keep my draft');
  expect(h.elements.get('conversation-status')!.innerHTML).toContain(error);
  expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
it('carries explicit organization and project selection into the request', async () => {
  const h = harness();
  await flush();
  h.window.location.href += '&organizationId=org-a&projectId=project-a';
  h.input.value = 'Scoped';
  h.form.fire('submit');
  await flush();
  const post = h.fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(post[1]!.body!)).toMatchObject({
    organizationId: 'org-a',
    projectId: 'project-a',
  });
});

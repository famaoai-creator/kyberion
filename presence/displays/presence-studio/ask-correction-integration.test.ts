import { describe, it, expect, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { safeReadFile } from '@agent/core/secure-io';

type TestEvent = {
  preventDefault: () => void;
  key?: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  repeat?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
};

class Element {
  requestSubmit = vi.fn(() => this.fire('submit'));
  value = '';
  innerHTML = '';
  textContent = '';
  disabled = false;
  hidden = true;
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection = 'none';
  setSelectionRange = vi.fn((start: number, end: number, direction: string) => {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  });
  focus = vi.fn();
  scrollIntoView = vi.fn();
  attributes: Record<string, string> = {};
  listeners: Record<string, (event: TestEvent) => void> = {};
  classList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() };
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  addEventListener(name: string, handler: (event: TestEvent) => void) {
    this.listeners[name] = handler;
  }
  fire(name: string, detail: Partial<TestEvent> = {}) {
    const event = { preventDefault: vi.fn(), ...detail };
    this.listeners[name]?.(event);
    return event;
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const vocabularyTexts = () =>
  new Proxy({} as Record<string, string>, {
    get: (_target, key) => String(key),
  });
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
    conversation?: () => Promise<ReturnType<typeof response>>;
    vocabulary?: Promise<ReturnType<typeof response>>;
    progress?: () => Promise<ReturnType<typeof response>>;
    vocabularyRead?: () => Promise<ReturnType<typeof response>>;
    texts?: Record<string, string>;
    speech?: boolean;
    recoveryScript?: boolean;
    correction?: () => Promise<ReturnType<typeof response>>;
    correctionScript?: boolean;
    query?: string;
    hash?: string;
  } = {}
) {
  const elements = new Map(
    [
      'ask-correction-status',
      'ask-correction-text',
      'ask-correction-retry',
      'ask-mic',
      'handsfree-toggle',
      'about-title',
      'about-empty',
      'ask-form',
      'ask-input',
      'ask-send',
      'turns',
      'ask-empty',
      'conversation-status',
      'conversation-selection',
      'conversation-reload',
      'conversation-legacy',
      'conversation-legacy-turns',
      'draft-choice',
      'draft-choice-preview',
      'draft-keep',
      'draft-replace',
      'draft-storage-warning',
      'draft-length-warning',
      'recent-card',
      'recent-title',
      'recent-list',
      'recent-status',
      'recent-loading',
      'recent-error',
      'recent-retry',
      'ask-startup-status',
      'ask-startup-loading',
      'ask-startup-error',
      'ask-startup-retry',
    ].map((id) => [id, new Element()])
  );
  const chips = new Map(
    ['email', 'minutes', 'browser', 'webapp', 'unknown'].map((key) => {
      const chip = new Element();
      chip.setAttribute('data-chip', key);
      return [key, chip] as const;
    })
  );
  const storage = options.storage ?? new Map<string, string>();
  const location = {
    reload: vi.fn(),
    href: 'http://localhost/ask' + (options.query ?? '?tenant=alpha') + (options.hash ?? ''),
    origin: 'http://localhost',
    pathname: '/ask',
    search: options.query ?? '?tenant=alpha',
    hash: options.hash ?? '',
  };
  const scopedUrl = (path: string) => {
    const url = new URL(path, location.href);
    url.searchParams.set('tenant', 'alpha');
    return url.origin === location.origin ? url.pathname + url.search : url.href;
  };
  const shellListeners: Array<(state: { phase: string; message: string }) => void> = [];
  const speechStart = vi.fn();
  const window = {
    location,
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    AbortController,
    SpeechRecognition: options.speech
      ? class {
          onstart?: () => void;
          onerror?: () => void;
          start() {
            speechStart();
            this.onstart?.();
            this.onerror?.();
          }
          stop() {}
        }
      : undefined,
    crypto: { randomUUID },
    history: {
      state: null,
      replaceState: vi.fn((_state: unknown, _title: string, url: string) => {
        const next = new URL(url, location.href);
        location.href = next.href;
        location.pathname = next.pathname;
        location.search = next.search;
        location.hash = next.hash;
      }),
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    KyberionPrefs: { locale: () => 'en', tenant: () => 'alpha', scopedUrl },
    FrontDeskRail: {
      ready: options.ready ?? Promise.resolve(),
      subscribe(listener: (state: { phase: string; message: string }) => void) {
        shellListeners.push(listener);
        return () => {};
      },
    },
    KyberionAsk: undefined as undefined | { mount: () => void },
    testProposeDraft: undefined as
      undefined | ((text: string, current: () => boolean, accepted: () => void) => boolean),
  };
  const texts =
    options.texts ??
    new Proxy({} as Record<string, string>, {
      get: (_target, key) => String(key),
    });
  const fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST')
      return options.post
        ? options.post(JSON.parse(init.body!))
        : response({ ok: true, reply: 'Done', mode: 'orchestrator' });
    if (url.startsWith('/api/ask-vocabulary'))
      return options.vocabularyRead
        ? options.vocabularyRead()
        : (options.vocabulary ?? response({ ok: true, texts }));
    if (url.includes('/correction-context?'))
      return options.correction
        ? options.correction()
        : response({
            ok: true,
            viewer_scope_id: 'a'.repeat(64),
            context: {
              entry_id: 'entry-1',
              artifact_id: 'artifact-1',
              title: 'Report',
              note: 'Exact saved comment',
              status: 'changes_requested',
            },
          });
    if (url.startsWith('/api/progress'))
      return options.progress ? options.progress() : response({ ok: true, active: [] });
    if (url.startsWith('/api/conversation'))
      return options.conversation
        ? options.conversation()
        : response(
            {
              ok: true,
              sessionId: session,
              messages: [],
              pending: 0,
              ...options.history,
            },
            options.historyStatus ?? 200
          );
    throw new Error('unexpected ' + url);
  });
  const document = {
    documentElement: { getAttribute: () => 'en' },
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelector: (selector: string) => {
      const key = /^\.ask-chip\[data-chip="([^"]+)"\]$/.exec(selector)?.[1];
      return key ? (chips.get(key) ?? null) : null;
    },
    querySelectorAll: (selector: string) => (selector === '.ask-chip' ? [...chips.values()] : []),
  };
  elements.get('ask-send')!.disabled = true;
  const scripts =
    options.recoveryScript === false
      ? ['ask.js']
      : [
          'ask-read-recovery.js',
          ...(options.correctionScript === false ? [] : ['ask-correction.js']),
          'ask.js',
        ];
  runInNewContext(
    scripts
      .map(
        (name) =>
          safeReadFile('presence/displays/presence-studio/static/' + name, {
            encoding: 'utf8',
          }) +
          (name === 'ask-correction.js'
            ? ';(function () { var create = window.KyberionAskCorrection.create; window.KyberionAskCorrection.create = function (options) { window.testProposeDraft = options.proposeDraft; return create(options); }; })();'
            : '')
      )
      .join('\n'),
    {
      window,
      document,
      fetch,
      navigator: {},
      URL,
      URLSearchParams,
      crypto: window.crypto,
      console,
    }
  );
  window.KyberionAsk?.mount();
  return {
    elements,
    speechStart,
    shell: (phase: string, message = '') =>
      shellListeners.forEach((listener) => listener({ phase, message })),
    chips,
    storage,
    fetch,
    window,
    input: elements.get('ask-input')!,
    form: elements.get('ask-form')!,
  };
}
describe('Ask correction integration with real draft ownership and startup', () => {
  const query = '?tenant=alpha&correction=entry-1&artifact=artifact-1&ask=malicious&send=1&mic=1';
  it('uses a multiline textarea and preserves recorded note line breaks in draft storage', async () => {
    const html = safeReadFile('presence/displays/presence-studio/static/ask.html', {
      encoding: 'utf8',
    }) as string;
    expect(html).toMatch(/<textarea[^>]*id="ask-input"[^>]*rows="2"[^>]*>[\s\S]*?<\/textarea>/);
    expect(html).not.toMatch(/<input[^>]*id="ask-input"/);
    const note = 'First line\nSecond line\n\nFinal line';
    const h = harness({
      query,
      correction: async () =>
        response({
          ok: true,
          viewer_scope_id: 'a'.repeat(64),
          context: {
            entry_id: 'entry-1',
            artifact_id: 'artifact-1',
            title: 'Report',
            note,
            status: 'changes_requested',
          },
        }),
    });
    await flush();
    expect(h.input.value.endsWith(note)).toBe(true);
    expect(h.storage.get('kyberion.ask.draft.' + session)).toBe(h.input.value);
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
  it('submits plain Enter once through the form and leaves modified Enter and IME input alone', async () => {
    const h = harness();
    await flush();
    h.input.value = 'Explicit mocked submission';
    h.input.fire('input');
    for (const detail of [
      { shiftKey: true },
      { isComposing: true },
      { keyCode: 229 },
      { repeat: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
    ]) {
      const event = h.input.fire('keydown', { key: 'Enter', ...detail });
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(h.form.requestSubmit).not.toHaveBeenCalled();
    const enter = h.input.fire('keydown', { key: 'Enter' });
    await flush();
    expect(enter.preventDefault).toHaveBeenCalledTimes(1);
    expect(h.form.requestSubmit).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('waits for verified history, then drafts without sending or starting speech', async () => {
    const history = deferred<ReturnType<typeof response>>();
    const h = harness({ query, speech: true, conversation: () => history.promise });
    await flush();
    expect(h.fetch.mock.calls.filter(([url]) => url.includes('correction-context'))).toHaveLength(
      0
    );
    history.resolve(response({ ok: true, sessionId: session, messages: [], pending: 0 }));
    await flush();
    expect(h.input.value).toContain('Exact saved comment');
    expect(h.input.value).toContain('entry-1');
    expect(h.input.value).toContain('artifact-1');
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    expect(h.speechStart).not.toHaveBeenCalled();
    expect(h.window.history.replaceState.mock.calls[0][2]).toBe('/ask?tenant=alpha');
  });
  it('preserves an earlier typed draft and pending request through Keep, Escape and Replace', async () => {
    for (const choice of ['keep', 'escape', 'replace']) {
      const read = deferred<ReturnType<typeof response>>();
      const request = JSON.stringify({
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        text: 'pending text',
        createdAt: 1,
      });
      const storage = new Map([['kyberion.ask.draft.' + session + '.request', request]]);
      const h = harness({ query, storage, correction: () => read.promise });
      await flush();
      h.input.value = 'Earlier typing';
      h.input.fire('input');
      read.resolve(
        response({
          ok: true,
          viewer_scope_id: 'a'.repeat(64),
          context: {
            entry_id: 'entry-1',
            artifact_id: 'artifact-1',
            title: 'Report',
            note: 'Saved revision',
            status: 'rejected',
          },
        })
      );
      await flush();
      expect(h.input.value).toBe('Earlier typing');
      expect(h.elements.get('draft-choice')!.hidden).toBe(false);
      expect(h.window.history.replaceState).not.toHaveBeenCalled();
      if (choice === 'escape') h.elements.get('draft-choice')!.fire('keydown', { key: 'Escape' });
      else h.elements.get(choice === 'keep' ? 'draft-keep' : 'draft-replace')!.fire('click');
      expect(h.input.value).toContain(choice === 'replace' ? 'Saved revision' : 'Earlier typing');
      expect(h.elements.get('draft-choice')!.hidden).toBe(true);
      expect(storage.get('kyberion.ask.draft.' + session + '.request')).toBe(request);
      expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
      expect(h.window.history.replaceState.mock.calls).toHaveLength(1);
      if (choice !== 'replace') expect(h.elements.get('ask-correction-status')!.hidden).toBe(true);
    }
  });
  it('does not revive dismissed feedback after keeping, manually sending and reloading a draft', async () => {
    for (const choice of ['keep', 'escape']) {
      const storage = new Map([['kyberion.ask.draft.' + session, 'My pitch draft']]);
      const h = harness({
        query: query + '&projectId=pitch&view=compact',
        hash: '#review',
        storage,
      });
      await flush();
      expect(h.elements.get('draft-choice')!.hidden).toBe(false);
      if (choice === 'keep') h.elements.get('draft-keep')!.fire('click');
      else h.elements.get('draft-choice')!.fire('keydown', { key: 'Escape' });
      expect(h.input.value).toBe('My pitch draft');
      expect(h.elements.get('ask-correction-status')!.hidden).toBe(true);
      expect(h.window.location.search).toBe('?tenant=alpha&projectId=pitch&view=compact');
      expect(h.window.location.hash).toBe('#review');
      h.form.fire('submit');
      await flush();
      expect(h.input.value).toBe('');
      expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
      const reload = harness({
        query: h.window.location.search,
        hash: h.window.location.hash,
        storage,
      });
      await flush();
      expect(reload.input.value).toBe('');
      expect(reload.elements.get('ask-correction-status')!.hidden).toBe(true);
      expect(
        reload.fetch.mock.calls.filter(([url]) => url.includes('correction-context'))
      ).toHaveLength(0);
      expect(reload.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
      const explicit = harness({ query, storage });
      await flush();
      expect(explicit.input.value).toContain('Exact saved comment');
      expect(explicit.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
        0
      );
    }
  });
  it('settles a correction proposal when the operator edits or sends the existing draft', async () => {
    for (const action of ['edit', 'send']) {
      const storage = new Map([['kyberion.ask.draft.' + session, 'My pitch draft']]);
      const h = harness({ query, storage });
      await flush();
      if (action === 'edit') {
        h.input.value = 'Revised pitch draft';
        h.input.fire('input');
      } else h.form.fire('submit');
      await flush();
      expect(h.elements.get('ask-correction-status')!.hidden).toBe(true);
      expect(h.window.location.search).toBe('?tenant=alpha');
      expect(h.input.value).toBe(action === 'edit' ? 'Revised pitch draft' : '');
      expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
        action === 'send' ? 1 : 0
      );
    }
  });
  it('retires the correction proposal when a chip replaces it without sending', async () => {
    const storage = new Map([['kyberion.ask.draft.' + session, 'My pitch draft']]);
    const h = harness({ query, storage });
    await flush();
    h.chips.get('email')!.fire('click');
    expect(h.window.location.search).toBe('?tenant=alpha');
    expect(h.elements.get('ask-correction-status')!.hidden).toBe(true);
    expect(h.elements.get('draft-choice')!.hidden).toBe(false);
    expect(h.elements.get('draft-choice-preview')!.textContent).toBe('front_desk:chip_email');
    h.elements.get('draft-replace')!.fire('click');
    expect(h.input.value).toBe('front_desk:chip_email');
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
  it('rejects an incoming proposal made stale by retiring the previous correction', async () => {
    for (const composer of ['My pitch draft', '']) {
      const storage = new Map([['kyberion.ask.draft.' + session, 'My pitch draft']]);
      const h = harness({ query, storage });
      await flush();
      const identity = h.window.location.search;
      h.input.value = composer;
      const accepted = vi.fn();
      const proposed = h.window.testProposeDraft!(
        'Stale next action',
        () => h.window.location.search === identity,
        accepted
      );
      expect(proposed).toBe(false);
      expect(h.window.location.search).toBe('?tenant=alpha');
      expect(h.elements.get('draft-choice')!.hidden).toBe(true);
      expect(h.elements.get('ask-correction-status')!.hidden).toBe(true);
      expect(h.input.value).toBe(composer);
      expect(storage.get('kyberion.ask.draft.' + session)).toBe('My pitch draft');
      expect(accepted).not.toHaveBeenCalled();
      expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    }
  });
  it('preserves a maximum note, blocks oversized sends, and clears warning after shortening', async () => {
    const note = 'x'.repeat(4000);
    const h = harness({
      query,
      correction: async () =>
        response({
          ok: true,
          viewer_scope_id: 'a'.repeat(64),
          context: {
            entry_id: 'entry-1',
            artifact_id: 'artifact-1',
            title: 'Report',
            note,
            status: 'rejected',
          },
        }),
    });
    await flush();
    expect(h.input.value.endsWith(note)).toBe(true);
    expect(h.input.value.length).toBeGreaterThan(4000);
    expect(h.elements.get('draft-length-warning')!.hidden).toBe(false);
    expect(h.elements.get('ask-send')!.disabled).toBe(true);
    h.form.fire('submit');
    await flush();
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    h.input.value = 'Please revise artifact-1 using entry-1';
    h.input.fire('input');
    expect(h.elements.get('draft-length-warning')!.hidden).toBe(true);
    expect(h.elements.get('ask-send')!.disabled).toBe(false);
  });
  it('restores an oversized saved draft with an accessible length warning', async () => {
    const storage = new Map([['kyberion.ask.draft.' + session, 'x'.repeat(4001)]]);
    const h = harness({ storage });
    await flush();
    expect(h.input.value.length).toBe(4001);
    expect(h.elements.get('draft-length-warning')!.hidden).toBe(false);
    expect(h.elements.get('ask-send')!.disabled).toBe(true);
  });
  it('shows oversized conflict preview without truncating it or changing the current draft', async () => {
    const read = deferred<ReturnType<typeof response>>();
    const note = 'x'.repeat(4000);
    const h = harness({ query, correction: () => read.promise });
    await flush();
    h.input.value = 'Keep mine';
    h.input.fire('input');
    read.resolve(
      response({
        ok: true,
        viewer_scope_id: 'a'.repeat(64),
        context: {
          entry_id: 'entry-1',
          artifact_id: 'artifact-1',
          title: 'Report',
          note,
          status: 'rejected',
        },
      })
    );
    await flush();
    expect(h.elements.get('draft-choice-preview')!.textContent.endsWith(note)).toBe(true);
    expect(h.elements.get('draft-length-warning')!.hidden).toBe(false);
    expect(h.input.value).toBe('Keep mine');
    h.elements.get('draft-keep')!.fire('click');
    expect(h.elements.get('draft-length-warning')!.hidden).toBe(true);
  });
  it('prioritizes request resume and fails closed if the correction script is missing', async () => {
    for (const options of [
      { query: query + '&request=request-1' },
      { query, correctionScript: false },
    ]) {
      const h = harness({ ...options, speech: true });
      await flush();
      expect(h.fetch.mock.calls.filter(([url]) => url.includes('correction-context'))).toHaveLength(
        0
      );
      expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
      expect(h.speechStart).not.toHaveBeenCalled();
      expect(h.input.value).toBe('');
    }
  });
  it('keeps draft after a failed read until explicit retry prepares the saved feedback', async () => {
    let calls = 0;
    const h = harness({
      query,
      correction: async () =>
        ++calls === 1
          ? response({}, 403)
          : response({
              ok: true,
              viewer_scope_id: 'a'.repeat(64),
              context: {
                entry_id: 'entry-1',
                artifact_id: 'artifact-1',
                title: 'Report',
                note: 'Retry note',
                status: 'rejected',
              },
            }),
    });
    h.input.value = 'Keep mine';
    h.input.fire('input');
    await flush();
    expect(calls).toBe(1);
    expect(h.input.value).toBe('Keep mine');
    expect(h.elements.get('ask-correction-retry')!.hidden).toBe(false);
    h.elements.get('ask-correction-retry')!.fire('click');
    await flush();
    expect(calls).toBe(2);
    expect(h.input.value).toBe('Keep mine');
    expect(h.elements.get('draft-choice-preview')!.textContent).toContain('Retry note');
  });
});

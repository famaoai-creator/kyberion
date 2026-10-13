import { describe, it, expect, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { safeReadFile } from '@agent/core/secure-io';

type TestEvent = { preventDefault: () => void; key?: string };

class Element {
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
    query?: string;
    hash?: string;
  } = {}
) {
  const elements = new Map(
    [
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
            this.onstart?.();
            this.onerror?.();
          }
          stop() {}
        }
      : undefined,
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
    options.recoveryScript === false ? ['ask.js'] : ['ask-read-recovery.js', 'ask.js'];
  runInNewContext(
    scripts
      .map((name) =>
        safeReadFile('presence/displays/presence-studio/static/' + name, {
          encoding: 'utf8',
        })
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
    chips,
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
    expect(h.fetch).toHaveBeenCalledWith('/api/conversation?tenant=alpha', {
      cache: 'no-store',
    });
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
      {
        role: 'companion',
        text: '<script>unsafe</script>',
        next_actions: [{ label: 'Run now' }],
      },
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
        {
          ok: false,
          error,
          retry_safe: error !== 'conversation_capability_unsupported',
        },
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

describe('work-home inert conversation selection', () => {
  it('selects the exact retained request without sending even with auto-send parameters', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const h = harness({
      query: '?tenant=alpha&request=' + id + '&ask=retry&send=1',
      history: {
        messages: [
          {
            id: id + '-user',
            role: 'user',
            text: 'First request',
            createdAt: 1,
          },
        ],
      },
    });
    await flush();
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    expect(h.elements.get('conversation-selection')!.textContent).toBe(
      'front_desk:work_home_resume_readonly'
    );
    expect(h.elements.get('turns')!.innerHTML).toContain('ask-turn-' + id + '-user');
  });

  it('reports an unavailable request rather than selecting another or replaying it', async () => {
    const h = harness({
      query: '?request=missing',
      history: {
        messages: [
          {
            id: 'another-user',
            role: 'user',
            text: 'Other request',
            createdAt: 1,
          },
        ],
      },
    });
    await flush();
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    expect(h.elements.get('conversation-selection')!.textContent).toBe(
      'front_desk:work_home_request_unavailable'
    );
  });

  it('retains uncertainty and sends nothing when the selected history is unavailable', async () => {
    const h = harness({
      query: '?request=missing&ask=retry&send=1',
      historyStatus: 503,
    });
    await flush();
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    expect(h.elements.get('ask-send')!.disabled).toBe(true);
  });
});

it('focuses a resumed request once after hydration, then leaves new messages visible', async () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const h = harness({
    query: '?request=' + id,
    history: {
      messages: [{ id: id + '-user', role: 'user', text: 'Prior request', createdAt: 1 }],
    },
  });
  const target = new Element();
  h.elements.set('ask-turn-' + id + '-user', target);
  await flush();
  expect(target.focus).toHaveBeenCalledTimes(1);
  h.elements.get('ask-input')!.value = 'A new message';
  h.elements.get('ask-form')!.fire('submit');
  await flush();
  expect(target.focus).toHaveBeenCalledTimes(1);
  expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
  expect(h.elements.get('turns')!.innerHTML).toContain('A new message');
});

describe('Ask draft consistency (DOM doubles, no visual claim)', () => {
  const draftKey = 'kyberion.ask.draft.' + session;
  const requestKey = draftKey + '.request';
  const chipText = 'front_desk:chip_email';
  const historyResponse = () =>
    response({ ok: true, sessionId: session, messages: [], pending: 0 });
  const posts = (h: ReturnType<typeof harness>) =>
    h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
  const edit = (h: ReturnType<typeof harness>, text: string) => {
    h.input.value = text;
    h.input.fire('input');
  };

  it.each(['empty', 'replace'])(
    'persists a chip from %s input across reload without sending',
    async (mode) => {
      const storage = new Map<string, string>();
      const h = harness({ storage });
      await flush();
      if (mode === 'replace') edit(h, 'Original draft');
      h.chips.get('email')!.fire('click');
      if (mode === 'replace') {
        expect(h.input.value).toBe('Original draft');
        expect(storage.get(draftKey)).toBe('Original draft');
        expect(h.elements.get('draft-choice')!.hidden).toBe(false);
        expect(h.elements.get('draft-choice-preview')!.textContent).toBe(chipText);
        h.elements.get('draft-replace')!.fire('click');
      }
      expect(h.input.value).toBe(chipText);
      expect(storage.get(draftKey)).toBe(chipText);
      expect(h.elements.get('draft-choice')!.hidden).toBe(true);
      expect(h.input.focus).toHaveBeenCalled();
      const reloaded = harness({ storage });
      await flush();
      expect(reloaded.input.value).toBe(chipText);
      expect(posts(h)).toHaveLength(0);
      expect(posts(reloaded)).toHaveLength(0);
    }
  );

  it.each(['keep', 'Escape', 'editor Escape'])(
    'preserves text, selection, and focus on %s',
    async (action) => {
      const h = harness();
      await flush();
      edit(h, 'Original draft');
      h.input.setSelectionRange(2, 8, 'backward');
      h.chips.get('email')!.fire('click');
      expect(h.elements.get('draft-keep')!.focus).toHaveBeenCalledTimes(1);
      h.input.setSelectionRange(0, 0, 'none');
      if (action === 'keep') h.elements.get('draft-keep')!.fire('click');
      else {
        const target = action === 'editor Escape' ? h.input : h.elements.get('draft-choice')!;
        if (action === 'editor Escape') h.input.focus();
        const event = target.fire('keydown', { key: 'Escape' });
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
      }
      expect(h.input.value).toBe('Original draft');
      expect(h.storage.get(draftKey)).toBe('Original draft');
      expect(h.input.setSelectionRange).toHaveBeenLastCalledWith(2, 8, 'backward');
      expect(h.input.focus).toHaveBeenCalled();
      expect(h.elements.get('draft-choice')!.hidden).toBe(true);
      h.elements.get('draft-replace')!.fire('click');
      expect(h.input.value).toBe('Original draft');
      expect(posts(h)).toHaveLength(0);
    }
  );

  it('requires a choice for conflicting URL prefill and cleans only handoff parameters', async () => {
    const storage = new Map([[draftKey, 'Saved draft']]);
    const h = harness({
      storage,
      query:
        '?tenant=alpha&organizationId=org-a&projectId=project-a&other=retained&ask=From+home&send=0&mic=0',
      hash: '#details',
    });
    await flush();
    expect(h.input.value).toBe('Saved draft');
    expect(storage.get(draftKey)).toBe('Saved draft');
    expect(h.elements.get('draft-choice')!.hidden).toBe(false);
    expect(h.elements.get('draft-choice-preview')!.textContent).toBe('From home');
    expect(h.window.history.replaceState).toHaveBeenCalledExactlyOnceWith(
      null,
      '',
      '/ask?tenant=alpha&organizationId=org-a&projectId=project-a&other=retained#details'
    );
    h.elements.get('draft-replace')!.fire('click');
    expect(storage.get(draftKey)).toBe('From home');
    const reloaded = harness({ storage });
    await flush();
    expect(reloaded.input.value).toBe('From home');
    expect(posts(h)).toHaveLength(0);
    expect(posts(reloaded)).toHaveLength(0);
  });

  it('persists a nonconflicting URL prefill without submitting it', async () => {
    const h = harness({ query: '?tenant=alpha&ask=From+home' });
    await flush();
    expect(h.input.value).toBe('From home');
    expect(h.storage.get(draftKey)).toBe('From home');
    expect(h.elements.get('draft-choice')!.hidden).toBe(true);
    expect(posts(h)).toHaveLength(0);
  });

  it.each(['before readiness', 'during vocabulary', 'during history'])(
    'preserves typing and deliberate clearing %s',
    async (stage) => {
      for (const text of ['Early edit', '']) {
        const ready = deferred<void>();
        const vocabulary = deferred<ReturnType<typeof response>>();
        const conversation = deferred<ReturnType<typeof response>>();
        const storage = new Map([[draftKey, 'Stale saved draft']]);
        const h = harness({
          storage,
          ready: ready.promise,
          vocabulary: vocabulary.promise,
          conversation: () => conversation.promise,
        });
        if (stage !== 'before readiness') ready.resolve();
        if (stage === 'during history')
          vocabulary.resolve(response({ ok: true, texts: vocabularyTexts() }));
        await flush();
        edit(h, 'Typed then changed');
        edit(h, text);
        expect(storage.get(draftKey)).toBe('Stale saved draft');
        expect(posts(h)).toHaveLength(0);
        ready.resolve();
        vocabulary.resolve(response({ ok: true, texts: vocabularyTexts() }));
        conversation.resolve(historyResponse());
        await flush();
        expect(h.input.value).toBe(text);
        expect(storage.get(draftKey)).toBe(text);
        expect(h.elements.get('ask-send')!.disabled).toBe(false);
        const reloaded = harness({ storage });
        await flush();
        expect(reloaded.input.value).toBe(text);
        expect(posts(h)).toHaveLength(0);
      }
    }
  );

  it('ignores early chip activation until stored history and draft are verified', async () => {
    const conversation = deferred<ReturnType<typeof response>>();
    const request = JSON.stringify({
      id: '44444444-4444-4444-8444-444444444444',
      text: 'Saved draft',
      createdAt: 1,
    });
    const storage = new Map([
      [draftKey, 'Saved draft'],
      [requestKey, request],
    ]);
    const h = harness({ storage, conversation: () => conversation.promise });
    await flush();
    expect(h.fetch).toHaveBeenCalledWith('/api/conversation?tenant=alpha', {
      cache: 'no-store',
    });
    expect(h.chips.get('email')!.disabled).toBe(true);
    // Deliberately invoke the handler even while disabled to exercise its own guard.
    h.chips.get('email')!.fire('click');
    expect(h.input.value).toBe('');
    expect(storage.get(draftKey)).toBe('Saved draft');
    expect(storage.get(requestKey)).toBe(request);
    expect(h.elements.get('draft-choice')!.hidden).toBe(true);
    conversation.resolve(historyResponse());
    await flush();
    expect(h.input.value).toBe('Saved draft');
    expect(h.chips.get('email')!.disabled).toBe(false);
    h.chips.get('email')!.fire('click');
    expect(h.elements.get('draft-choice')!.hidden).toBe(false);
    expect(h.elements.get('draft-choice-preview')!.textContent).toBe(chipText);
    expect(h.input.value).toBe('Saved draft');
    expect(storage.get(draftKey)).toBe('Saved draft');
    expect(storage.get(requestKey)).toBe(request);
    expect(posts(h)).toHaveLength(0);
  });

  it('offers a URL choice against an early edit rather than restoring the old draft', async () => {
    const ready = deferred<void>();
    const h = harness({
      ready: ready.promise,
      storage: new Map([[draftKey, 'Stale saved draft']]),
      query: '?tenant=alpha&ask=Home+proposal',
    });
    edit(h, 'Early edit');
    ready.resolve();
    await flush();
    expect(h.input.value).toBe('Early edit');
    expect(h.storage.get(draftKey)).toBe('Early edit');
    expect(h.elements.get('draft-choice-preview')!.textContent).toBe('Home proposal');
    expect(h.elements.get('draft-choice')!.hidden).toBe(false);
    expect(posts(h)).toHaveLength(0);
  });

  it.each(['Typed after failure', ''])(
    'flushes edits after history failure and retry (%s)',
    async (text) => {
      let attempts = 0;
      const retry = deferred<ReturnType<typeof response>>();
      const h = harness({
        storage: new Map([[draftKey, 'Stale saved draft']]),
        conversation: async () => (++attempts === 1 ? response({ ok: false }, 503) : retry.promise),
      });
      await flush();
      expect(h.elements.get('ask-send')!.disabled).toBe(true);
      edit(h, 'Changed before retry');
      edit(h, text);
      expect(h.storage.get(draftKey)).toBe('Stale saved draft');
      h.elements.get('conversation-reload')!.fire('click');
      await flush();
      retry.resolve(historyResponse());
      await flush();
      expect(attempts).toBe(2);
      expect(h.input.value).toBe(text);
      expect(h.storage.get(draftKey)).toBe(text);
      expect(h.elements.get('ask-send')!.disabled).toBe(false);
      expect(posts(h)).toHaveLength(0);
    }
  );

  it('retains a URL candidate through failed history and offers a choice after retry', async () => {
    let attempts = 0;
    const retry = deferred<ReturnType<typeof response>>();
    const h = harness({
      storage: new Map([[draftKey, 'Unknown saved draft']]),
      query: '?tenant=alpha&ask=Candidate',
      conversation: async () => (++attempts === 1 ? response({ ok: false }, 503) : retry.promise),
    });
    await flush();
    expect(h.input.value).toBe('');
    expect(h.storage.get(draftKey)).toBe('Unknown saved draft');
    expect(h.window.history.replaceState).not.toHaveBeenCalled();
    expect(h.elements.get('draft-choice')!.hidden).toBe(true);
    expect(posts(h)).toHaveLength(0);
    h.elements.get('conversation-reload')!.fire('click');
    await flush();
    expect(h.window.history.replaceState).not.toHaveBeenCalled();
    retry.resolve(historyResponse());
    await flush();
    expect(h.input.value).toBe('Unknown saved draft');
    expect(h.storage.get(draftKey)).toBe('Unknown saved draft');
    expect(h.elements.get('draft-choice')!.hidden).toBe(false);
    expect(h.elements.get('draft-choice-preview')!.textContent).toBe('Candidate');
    expect(h.window.history.replaceState).toHaveBeenCalledExactlyOnceWith(
      null,
      '',
      '/ask?tenant=alpha'
    );
    expect(posts(h)).toHaveLength(0);
  });

  it('retains URL prefill and saved draft when request metadata is corrupt', async () => {
    const h = harness({
      storage: new Map([
        [draftKey, 'Unknown saved draft'],
        [requestKey, '{corrupt'],
      ]),
      query: '?tenant=alpha&ask=Candidate',
    });
    await flush();
    expect(h.input.value).toBe('');
    expect(h.storage.get(draftKey)).toBe('Unknown saved draft');
    expect(h.storage.get(requestKey)).toBe('{corrupt');
    expect(h.window.history.replaceState).not.toHaveBeenCalled();
    expect(h.elements.get('draft-choice')!.hidden).toBe(true);
    expect(h.elements.get('ask-send')!.disabled).toBe(true);
    expect(posts(h)).toHaveLength(0);
  });

  it('retains pending request metadata across keep, replace, and reload, then reuses its retry ID', async () => {
    const request = {
      id: '33333333-3333-4333-8333-333333333333',
      text: 'Uncertain request',
      createdAt: 1,
    };
    const raw = JSON.stringify(request);
    const storage = new Map([
      [draftKey, request.text],
      [requestKey, raw],
    ]);
    const h = harness({ storage });
    await flush();
    h.chips.get('email')!.fire('click');
    expect(storage.get(requestKey)).toBe(raw);
    h.elements.get('draft-keep')!.fire('click');
    expect(storage.get(requestKey)).toBe(raw);
    h.chips.get('email')!.fire('click');
    h.elements.get('draft-replace')!.fire('click');
    expect(storage.get(requestKey)).toBe(raw);
    const reloaded = harness({ storage });
    await flush();
    expect(storage.get(requestKey)).toBe(raw);
    expect(posts(h)).toHaveLength(0);
    expect(posts(reloaded)).toHaveLength(0);
    edit(reloaded, request.text);
    reloaded.form.fire('submit');
    await flush();
    expect(posts(reloaded)).toHaveLength(1);
    expect(JSON.parse(posts(reloaded)[0][1]!.body!).request_id).toBe(request.id);
  });

  it('does not erase the current draft for an unavailable or unknown chip', async () => {
    const h = harness({ texts: {} });
    await flush();
    edit(h, 'Keep me');
    h.chips.get('email')!.fire('click');
    h.chips.get('unknown')!.fire('click');
    expect(h.input.value).toBe('Keep me');
    expect(h.storage.get(draftKey)).toBeUndefined();
    expect(h.elements.get('ask-send')!.disabled).toBe(true);
    expect(h.elements.get('ask-startup-error')!.hidden).toBe(false);
    expect(h.elements.get('draft-choice')!.hidden).toBe(true);
    expect(posts(h)).toHaveLength(0);
  });

  it.each(['throws', 'silently drops'])(
    'keeps accepted text and warns when draft storage %s',
    async (failure) => {
      const h = harness();
      await flush();
      edit(h, 'Saved draft');
      const setItem = h.window.sessionStorage.setItem;
      h.window.sessionStorage.setItem = (key, value) => {
        if (key !== draftKey) return setItem(key, value);
        if (failure === 'throws') throw new Error('write blocked');
        return h.storage;
      };
      h.chips.get('email')!.fire('click');
      h.elements.get('draft-replace')!.fire('click');
      expect(h.input.value).toBe(chipText);
      expect(h.storage.get(draftKey)).toBe('Saved draft');
      expect(h.elements.get('draft-storage-warning')!.hidden).toBe(false);
      expect(h.elements.get('draft-storage-warning')!.textContent).toBe(
        'front_desk:ask_draft_not_saved'
      );
      expect(posts(h)).toHaveLength(0);
      h.window.sessionStorage.setItem = setItem;
      edit(h, 'Now saved');
      expect(h.storage.get(draftKey)).toBe('Now saved');
      expect(h.elements.get('draft-storage-warning')!.hidden).toBe(true);
    }
  );

  it('treats equal text as an idempotent acceptance without a replacement choice', async () => {
    const h = harness({ storage: new Map([[draftKey, chipText]]) });
    await flush();
    h.chips.get('email')!.fire('click');
    h.chips.get('email')!.fire('click');
    expect(h.input.value).toBe(chipText);
    expect(h.storage.get(draftKey)).toBe(chipText);
    expect(h.elements.get('draft-choice')!.hidden).toBe(true);
    expect(h.elements.get('draft-keep')!.focus).not.toHaveBeenCalled();
    expect(posts(h)).toHaveLength(0);
  });

  it('replaces only with the latest proposal and cancels stale choices on new input', async () => {
    const h = harness();
    await flush();
    edit(h, 'Original');
    h.chips.get('email')!.fire('click');
    h.chips.get('minutes')!.fire('click');
    expect(h.elements.get('draft-choice-preview')!.textContent).toBe('front_desk:chip_minutes');
    expect(h.input.value).toBe('Original');
    h.elements.get('draft-replace')!.fire('click');
    expect(h.storage.get(draftKey)).toBe('front_desk:chip_minutes');
    h.chips.get('email')!.fire('click');
    edit(h, 'New typing');
    expect(h.elements.get('draft-choice')!.hidden).toBe(true);
    h.elements.get('draft-replace')!.fire('click');
    expect(h.input.value).toBe('New typing');
    expect(h.storage.get(draftKey)).toBe('New typing');
    expect(posts(h)).toHaveLength(0);
  });

  it('preserves explicit send=1 behavior without a replacement choice', async () => {
    const pending = deferred<ReturnType<typeof response>>();
    const h = harness({
      storage: new Map([[draftKey, 'Older draft']]),
      query: '?tenant=alpha&ask=Explicit+submission&send=1',
      post: () => pending.promise,
    });
    await flush();
    expect(posts(h)).toHaveLength(1);
    expect(JSON.parse(posts(h)[0][1]!.body!)).toMatchObject({
      text: 'Explicit submission',
    });
    expect(h.elements.get('draft-choice')!.hidden).toBe(true);
    pending.resolve(response({ ok: true, reply: 'Done', mode: 'orchestrator' }));
    await flush();
  });

  it('leaves saved draft and URL untouched for read-only request selection', async () => {
    const h = harness({
      storage: new Map([[draftKey, 'Saved draft']]),
      query: '?tenant=alpha&request=missing&ask=Do+not+prefill&send=1&mic=1',
      hash: '#details',
    });
    await flush();
    expect(h.input.value).toBe('Saved draft');
    expect(h.storage.get(draftKey)).toBe('Saved draft');
    expect(h.elements.get('draft-choice')!.hidden).toBe(true);
    expect(h.window.history.replaceState).not.toHaveBeenCalled();
    expect(posts(h)).toHaveLength(0);
  });
});

describe('Ask optional recent-read isolation', () => {
  it.each(['rejected', 'pending'])(
    'restores conversation when recent requests are %s',
    async (mode) => {
      const recent = deferred<ReturnType<typeof response>>();
      const h = harness({
        progress: () =>
          mode === 'rejected' ? Promise.reject(new Error('offline')) : recent.promise,
        history: {
          messages: [{ id: 'display-only', role: 'secretary', text: 'Restored history' }],
        },
      });
      await flush();
      expect(h.fetch).toHaveBeenCalledWith('/api/conversation?tenant=alpha', {
        cache: 'no-store',
      });
      expect(h.elements.get('turns')!.innerHTML).toContain('Restored history');
      expect(h.elements.get('ask-send')!.disabled).toBe(false);
      expect(h.chips.get('email')!.innerHTML).toContain('front_desk:chip_email');
      expect(h.fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
      recent.resolve(response({ ok: true, active: [] }));
      await flush();
    }
  );
});

describe('Ask read recovery', () => {
  it('retries only recent reads without restoring history or changing the draft', async () => {
    let attempts = 0;
    const retry = deferred<ReturnType<typeof response>>();
    const h = harness({
      progress: async () => (++attempts === 1 ? response({ ok: false }, 503) : retry.promise),
    });
    await flush();
    expect(h.elements.get('recent-error')!.hidden).toBe(false);
    expect(h.elements.get('recent-retry')!.hidden).toBe(false);
    h.input.value = 'Keep this draft';
    h.input.fire('input');
    h.elements.get('recent-retry')!.fire('click');
    h.elements.get('recent-retry')!.fire('click');
    await flush();
    expect(attempts).toBe(2);
    expect(h.elements.get('recent-retry')!.disabled).toBe(true);
    retry.resolve(response({ ok: true, active: [{ id: 'new', title: 'Current request' }] }));
    await flush();
    expect(h.elements.get('recent-list')!.innerHTML).toContain('Current request');
    expect(h.elements.get('recent-error')!.hidden).toBe(true);
    expect(h.input.value).toBe('Keep this draft');
    expect(h.fetch.mock.calls.filter(([url]) => url.startsWith('/api/conversation'))).toHaveLength(
      1
    );
    expect(h.fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });

  it('times out optional reads and rejects a late result after an explicit retry', async () => {
    vi.useFakeTimers();
    try {
      const old = deferred<ReturnType<typeof response>>();
      let attempts = 0;
      const h = harness({
        progress: () =>
          ++attempts === 1
            ? old.promise
            : Promise.resolve(
                response({
                  ok: true,
                  active: [{ id: 'new', title: 'New result' }],
                })
              ),
      });
      await flush();
      expect(h.elements.get('ask-send')!.disabled).toBe(false);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.elements.get('recent-error')!.hidden).toBe(false);
      h.elements.get('recent-retry')!.fire('click');
      await flush();
      old.resolve(response({ ok: true, active: [{ id: 'old', title: 'Old result' }] }));
      await flush();
      expect(h.elements.get('recent-list')!.innerHTML).toContain('New result');
      expect(h.elements.get('recent-list')!.innerHTML).not.toContain('Old result');
      expect(h.fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps rendered labels on vocabulary failure and restores early edits after read-only retry', async () => {
    let attempts = 0;
    const retry = deferred<ReturnType<typeof response>>();
    const h = harness({
      vocabularyRead: () =>
        ++attempts === 1 ? Promise.reject(new Error('offline')) : retry.promise,
    });
    h.chips.get('email')!.innerHTML = 'Server-rendered mail label';
    await flush();
    expect(h.chips.get('email')!.innerHTML).toBe('Server-rendered mail label');
    expect(h.elements.get('ask-startup-error')!.hidden).toBe(false);
    expect(h.elements.get('ask-send')!.disabled).toBe(true);
    h.input.value = 'Edited while preparing';
    h.input.fire('input');
    h.elements.get('ask-startup-retry')!.fire('click');
    h.elements.get('ask-startup-retry')!.fire('click');
    await flush();
    expect(attempts).toBe(2);
    retry.resolve(response({ ok: true, texts: vocabularyTexts() }));
    await flush();
    expect(h.input.value).toBe('Edited while preparing');
    expect(h.elements.get('ask-startup-status')!.hidden).toBe(true);
    expect(h.elements.get('ask-send')!.disabled).toBe(false);
    expect(h.fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });
});

it('keeps startup retries behind verified rail readiness', async () => {
  const ready = deferred<void>();
  const h = harness({ ready: ready.promise });
  h.elements.get('ask-startup-retry')!.fire('click');
  await flush();
  expect(h.fetch).not.toHaveBeenCalled();
  ready.resolve();
  await flush();
  expect(h.fetch.mock.calls.filter(([url]) => url.startsWith('/api/ask-vocabulary'))).toHaveLength(
    1
  );
  expect(h.elements.get('ask-send')!.disabled).toBe(false);
});

describe('Ask startup fallback contracts', () => {
  it.each([null, {}, [], { 'front_desk:home_ask_send': ' ' }])(
    'rejects unusable vocabulary %j without wiping labels',
    async (texts) => {
      const h = harness({
        vocabulary: Promise.resolve(response({ ok: true, texts })),
      });
      h.chips.get('email')!.innerHTML = 'Server mail label';
      await flush();
      expect(h.elements.get('ask-startup-error')!.hidden).toBe(false);
      expect(h.chips.get('email')!.innerHTML).toBe('Server mail label');
      expect(h.fetch.mock.calls.some(([url]) => url.startsWith('/api/conversation'))).toBe(false);
      expect(h.elements.get('ask-send')!.disabled).toBe(true);
    }
  );

  it('preserves voice labels while vocabulary is unavailable without changing voice actions', async () => {
    const h = harness({
      speech: true,
      vocabulary: Promise.reject(new Error('offline')),
    });
    const toggle = h.elements.get('handsfree-toggle')!;
    toggle.textContent = 'Server off';
    toggle.setAttribute('data-label-on', 'Server on');
    toggle.setAttribute('data-label-off', 'Server off');
    h.elements.get('about-title')!.textContent = 'Server about title';
    h.elements.get('about-empty')!.textContent = 'Server about text';
    await flush();
    h.elements.get('ask-mic')!.fire('click');
    toggle.fire('click');
    await flush();
    expect(toggle.attributes['aria-pressed']).toBe('true');
    expect(toggle.textContent).toBe('Server on');
    expect(h.elements.get('about-title')!.textContent).toBe('Server about title');
    expect(h.elements.get('about-empty')!.textContent).toBe('Server about text');
    expect(
      h.fetch.mock.calls.some(
        ([url, init]) => url === '/api/conversation' && init?.method === 'POST'
      )
    ).toBe(false);
    toggle.fire('click');
    await flush();
    expect(toggle.textContent).toBe('Server off');
  });

  it('times out startup and ignores its late response after a manual retry', async () => {
    vi.useFakeTimers();
    try {
      const old = deferred<ReturnType<typeof response>>();
      let attempts = 0;
      const h = harness({
        vocabularyRead: () =>
          ++attempts === 1
            ? old.promise
            : Promise.resolve(response({ ok: true, texts: vocabularyTexts() })),
      });
      await flush();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.elements.get('ask-startup-error')!.hidden).toBe(false);
      h.elements.get('ask-startup-retry')!.fire('click');
      await flush();
      old.resolve(response({ ok: true, texts: {} }));
      await flush();
      expect(h.elements.get('ask-send')!.disabled).toBe(false);
      expect(h.elements.get('ask-startup-status')!.hidden).toBe(true);
      expect(
        h.fetch.mock.calls.filter(([url]) => url.startsWith('/api/conversation'))
      ).toHaveLength(1);
      expect(h.fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not bypass failed rail readiness on retry', async () => {
    const h = harness({
      ready: Promise.reject(new Error('scope unavailable')),
    });
    await flush();
    expect(h.elements.get('ask-startup-error')!.hidden).toBe(false);
    h.elements.get('ask-startup-retry')!.fire('click');
    await flush();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.elements.get('ask-send')!.disabled).toBe(true);
  });
});

it.each([null, { ok: false }, { ok: true }, { ok: true, active: {} }])(
  'does not mistake malformed recent data %j for an empty list',
  async (body) => {
    const h = harness({ progress: async () => response(body) });
    await flush();
    expect(h.elements.get('recent-error')!.hidden).toBe(false);
    expect(h.elements.get('recent-list')!.hidden).toBe(true);
    expect(h.elements.get('recent-retry')!.hidden).toBe(false);
    expect(h.elements.get('ask-send')!.disabled).toBe(false);
    expect(h.fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  }
);

it('keeps a newer post-success recent refresh when the initial read arrives late', async () => {
  const old = deferred<ReturnType<typeof response>>();
  let reads = 0;
  const h = harness({
    progress: () =>
      ++reads === 1
        ? old.promise
        : Promise.resolve(
            response({
              ok: true,
              active: [{ id: 'new', title: 'New result' }],
            })
          ),
  });
  await flush();
  h.input.value = 'One synthetic request';
  h.form.fire('submit');
  await flush();
  expect(reads).toBe(2);
  old.resolve(response({ ok: true, active: [{ id: 'old', title: 'Old result' }] }));
  await flush();
  expect(h.elements.get('recent-list')!.innerHTML).toContain('New result');
  expect(h.elements.get('recent-list')!.innerHTML).not.toContain('Old result');
  expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it('shows SSR startup recovery and only reloads the page when the helper script is missing', () => {
  const h = harness({ recoveryScript: false });
  expect(h.window.KyberionAsk).toBeUndefined();
  expect(h.elements.get('ask-startup-status')!.hidden).toBe(false);
  expect(h.elements.get('ask-startup-loading')!.hidden).toBe(true);
  expect(h.elements.get('ask-startup-error')!.hidden).toBe(false);
  expect(h.elements.get('ask-startup-retry')!.hidden).toBe(false);
  expect(h.elements.get('ask-send')!.disabled).toBe(true);
  expect(h.fetch).not.toHaveBeenCalled();
  h.elements.get('ask-startup-retry')!.fire('click');
  expect(h.window.location.reload).toHaveBeenCalledTimes(1);
  expect(h.fetch).not.toHaveBeenCalled();
});

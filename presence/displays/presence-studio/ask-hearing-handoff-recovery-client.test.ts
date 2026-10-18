import { afterEach, describe, expect, it, vi } from 'vitest';
import { harness, response, flush, deferred, session } from './ask-client-test-harness.js';

const SESSION = 'handoff-recovery-session';
const KEY = 'kyberion.ask.hearing.completion.' + SESSION;
const SCOPE = '/api/conversation?tenant=alpha&organizationId=org-a&projectId=project-a';
type Reply = ReturnType<typeof response>;
const never = (): Promise<Reply> => new Promise(() => {});
const posts = (h: ReturnType<typeof harness>) =>
  h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
const reads = (h: ReturnType<typeof harness>) =>
  h.fetch.mock.calls.filter(
    ([url, init]) => url.startsWith('/api/hearing/') && init?.method !== 'POST'
  );
const click = (h: ReturnType<typeof harness>) => h.elements.get('hearing-handoff')!.fire('click');
const check = (h: ReturnType<typeof harness>) =>
  h.elements.get('hearing-completion-check')!.fire('click');
const label = (h: ReturnType<typeof harness>) =>
  h.elements.get('hearing-completion-text')!.textContent;
const href = (h: ReturnType<typeof harness>) =>
  h.elements.get('hearing-handoff-link')!.attributes.href ?? '';
function mutations(h: ReturnType<typeof harness>) {
  click(h);
  h.elements.get('hearing-decide')!.fire('click');
  h.input.value = 'Another private answer';
  h.form.fire('submit');
}
function locked(h: ReturnType<typeof harness>) {
  expect(h.elements.get('hearing-handoff')!.disabled).toBe(true);
  expect(h.elements.get('hearing-decide')!.disabled).toBe(true);
  expect(h.elements.get('ask-send')!.disabled).toBe(true);
}
afterEach(() => vi.useRealTimers());

describe.each(['mission', 'inventory'] as const)('%s completion uncertainty recovery', (kind) => {
  const scenario = kind === 'inventory' ? 'work_inventory' : 'web_app_build';
  const endpoint = kind === 'inventory' ? 'inventory' : 'handoff';
  const query =
    '?mode=hearing&scenario=' + scenario + '&tenant=alpha&organizationId=org-a&projectId=project-a';
  const record = {
    session_id: SESSION,
    scenario,
    requirements: [{ answer: 'Private completion answer' }],
    decided_at: '2026-10-17T00:00:00Z',
  };
  const marker = {
    version: 1,
    kind,
    operationId: 'completion-operation-1',
    scenarioId: scenario,
    conversationId: session,
    scope: SCOPE,
  };
  const ready = {
    kind,
    status: 'ready',
    id: 'SAVED-RESULT',
    next: { href: '/progress?result=SAVED-RESULT' },
  };
  const success = (id = 'POST-RESULT') =>
    response(
      kind === 'mission'
        ? { ok: true, mission_id: id, next_action: { href: '/progress?result=' + id } }
        : { ok: true, entry_id: id, next: { href: '/progress?result=' + id } }
    );
  const pendingStorage = () =>
    new Map([
      ['kyberion.ask.session_id', SESSION],
      [KEY, JSON.stringify(marker)],
    ]);
  function setup(
    options: {
      post?: () => Promise<Reply>;
      read?: (number: number) => Promise<Reply>;
      storage?: Map<string, string>;
    } = {}
  ) {
    let readCount = 0;
    return harness({
      query,
      storage: options.storage ?? new Map([['kyberion.ask.session_id', SESSION]]),
      hearing: async (_url, init) =>
        init?.method === 'POST'
          ? (options.post ?? never)()
          : options.read
            ? options.read(++readCount)
            : response({ ok: true, record }),
    });
  }

  it('persists its minimal no-resend marker before dispatch and blocks synchronous duplicate mutations', async () => {
    const storage = new Map([['kyberion.ask.session_id', SESSION]]);
    let savedBeforeDispatch: string | undefined;
    const h = setup({
      storage,
      post: () => {
        savedBeforeDispatch = storage.get(KEY);
        return never();
      },
    });
    await flush();
    click(h);
    mutations(h);
    await flush();
    expect(posts(h)).toHaveLength(1);
    expect(posts(h)[0][0]).toContain('/' + endpoint + '?');
    expect(savedBeforeDispatch).toBeTruthy();
    expect(JSON.parse(savedBeforeDispatch!)).toEqual({
      ...marker,
      operationId: expect.any(String),
    });
    expect(JSON.parse(savedBeforeDispatch!).operationId).not.toBe('');
    expect(savedBeforeDispatch).not.toContain('Private completion answer');
    expect(label(h)).toBe('front_desk:hearing_completion_pending');
    locked(h);
    h.browserEvent('pagehide');
  });

  it.each(['fetch', 'json'])(
    'bounds a hanging %s at 60 seconds without resending',
    async (phase) => {
      vi.useFakeTimers();
      const h = setup({
        post: phase === 'fetch' ? never : async () => ({ ...response({}), json: never }),
      });
      await flush();
      click(h);
      await flush();
      await vi.advanceTimersByTimeAsync(59999);
      expect(label(h)).toBe('front_desk:hearing_completion_pending');
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(label(h)).toBe('front_desk:hearing_completion_unknown');
      expect(h.elements.get('hearing-completion-status')!.attributes['aria-busy']).toBe('false');
      mutations(h);
      await flush();
      expect(posts(h)).toHaveLength(1);
      expect(h.storage.has(KEY)).toBe(true);
      locked(h);
    }
  );

  it.each(['network', 'json', '500', 'malformed-200'])(
    'retains %s uncertainty across reload and offers scoped ordinary conversation',
    async (failure) => {
      const h = setup({
        post: async () => {
          if (failure === 'network') throw new Error('offline');
          if (failure === 'json')
            return {
              ...response({}),
              json: async () => {
                throw new Error('invalid JSON');
              },
            };
          return response(
            failure === '500' ? { ok: false } : { ok: true },
            failure === '500' ? 500 : 200
          );
        },
      });
      await flush();
      click(h);
      await flush();
      expect(label(h)).toBe('front_desk:hearing_completion_unknown');
      expect(h.storage.has(KEY)).toBe(true);
      const restored = setup({ storage: h.storage });
      await flush();
      mutations(restored);
      await flush();
      locked(restored);
      expect(posts(restored)).toHaveLength(0);
      const exit = restored.elements.get('hearing-completion-continue')!;
      expect(exit.hidden).toBe(false);
      expect(exit.attributes.href).toContain('tenant=alpha');
      expect(exit.attributes.href).toContain('organizationId=org-a');
      expect(exit.attributes.href).toContain('projectId=project-a');
      expect(exit.attributes.href).not.toContain('mode=hearing');
      const ordinary = harness({ storage: h.storage });
      await flush();
      expect(ordinary.elements.get('ask-send')!.disabled).toBe(false);
      expect(h.storage.has(KEY)).toBe(true);
    }
  );

  it.each([200, 400, 401, 403])(
    'clears only its own definitive %s response, including after the deadline',
    async (status) => {
      vi.useFakeTimers();
      const wait = deferred<Reply>();
      const h = setup({ post: () => wait.promise });
      await flush();
      click(h);
      await flush();
      await vi.advanceTimersByTimeAsync(60000);
      expect(h.storage.has(KEY)).toBe(true);
      wait.resolve(status === 200 ? success() : response({ ok: false }, status));
      await flush();
      expect(h.storage.has(KEY)).toBe(false);
      expect(posts(h)).toHaveLength(1);
      if (status === 200) expect(href(h)).toContain('POST-RESULT');
      else expect(h.elements.get('hearing-handoff')!.disabled).toBe(false);
    }
  );

  it.each([
    ['no id', undefined, '/progress'],
    ['empty id', '', '/progress'],
    ['invalid id', '<private>', '/progress'],
    ['no destination', 'RESULT', undefined],
    ['unsafe destination', 'RESULT', 'javascript:alert(1)'],
    ['send destination', 'RESULT', '/ask?send=1'],
  ])('keeps a 200 with %s guarded', async (_reason, id, destination) => {
    const h = setup({
      post: async () =>
        response(
          kind === 'mission'
            ? { ok: true, mission_id: id, next_action: { href: destination } }
            : { ok: true, entry_id: id, next: { href: destination } }
        ),
    });
    await flush();
    click(h);
    await flush();
    expect(h.storage.has(KEY)).toBe(true);
    expect(label(h)).toBe('front_desk:hearing_completion_unknown');
    expect(href(h)).toBe('');
    locked(h);
  });

  it.each([
    'ready',
    'absent',
    'unavailable',
    'malformed',
    'malformed-body',
    'network',
    'json',
    '401',
    '403',
    '500',
  ])('checks %s with GET only, never treating GET as completion proof', async (outcome) => {
    const h = setup({
      storage: pendingStorage(),
      read: async (number) => {
        if (number === 1) return response({ ok: true, record });
        if (outcome === 'network') throw new Error('offline');
        if (outcome === 'json')
          return {
            ...response({}),
            json: async () => {
              throw new Error('invalid JSON');
            },
          };
        if (outcome === 'malformed-body')
          return response({ ok: true, record: null, completion: ready });
        const completion =
          outcome === 'ready'
            ? ready
            : outcome === 'absent'
              ? undefined
              : outcome === 'unavailable'
                ? { kind, status: 'unavailable' }
                : { ...ready, next: { href: 'javascript:alert(1)' } };
        return response(
          { ok: true, record, completion },
          /^\d/.test(outcome) ? Number(outcome) : 200
        );
      },
    });
    await flush();
    const saved = h.storage.get(KEY);
    check(h);
    check(h);
    await flush();
    expect(reads(h)).toHaveLength(2);
    expect(h.storage.get(KEY)).toBe(saved);
    expect(h.elements.get('hearing-completion-check')!.disabled).toBe(false);
    if (outcome === 'ready') expect(href(h)).toContain('SAVED-RESULT');
    else expect(href(h)).toBe('');
    mutations(h);
    await flush();
    locked(h);
    expect(posts(h)).toHaveLength(0);
  });

  it.each(['fetch', 'json'])(
    'bounds stalled GET %s at 20 seconds and ignores its late destination',
    async (phase) => {
      vi.useFakeTimers();
      const wait = deferred<Reply>();
      const body = deferred<unknown>();
      const h = setup({
        storage: pendingStorage(),
        read: async (number) => {
          if (number === 1) return response({ ok: true, record });
          if (number > 2) return response({ ok: true, record, completion: ready });
          return phase === 'fetch' ? wait.promise : { ...response({}), json: () => body.promise };
        },
      });
      await flush();
      check(h);
      await flush();
      expect(label(h)).toBe('front_desk:hearing_completion_checking');
      await vi.advanceTimersByTimeAsync(20000);
      await flush();
      expect(h.elements.get('hearing-completion-check')!.disabled).toBe(false);
      expect(h.storage.has(KEY)).toBe(true);
      const old = {
        ok: true,
        record,
        completion: { ...ready, id: 'OLD', next: { href: '/progress?old=1' } },
      };
      wait.resolve(response(old));
      body.resolve(old);
      await flush();
      expect(href(h)).toBe('');
      check(h);
      await flush();
      expect(href(h)).toContain('SAVED-RESULT');
      expect(h.storage.has(KEY)).toBe(true);
      expect(reads(h)).toHaveLength(3);
      expect(posts(h)).toHaveLength(0);
    }
  );

  it.each(
    [200, 403].flatMap((status) =>
      ['ready', 'absent', 'denied', 'network'].map((outcome) => ({ status, outcome }))
    )
  )(
    'retires a late original POST $status after a newer $outcome check',
    async ({ status, outcome }) => {
      vi.useFakeTimers();
      const wait = deferred<Reply>();
      const h = setup({
        post: () => wait.promise,
        read: async (number) => {
          if (number === 1) return response({ ok: true, record });
          if (outcome === 'network') throw new Error('offline');
          return response(
            { ok: true, record, completion: outcome === 'ready' ? ready : undefined },
            outcome === 'denied' ? 403 : 200
          );
        },
      });
      await flush();
      click(h);
      await flush();
      await vi.advanceTimersByTimeAsync(60000);
      const saved = h.storage.get(KEY);
      check(h);
      await flush();
      const destination = href(h);
      if (outcome === 'ready') expect(destination).toContain('SAVED-RESULT');
      else expect(destination).toBe('');
      wait.resolve(status === 200 ? success('OLD-POST') : response({ ok: false }, status));
      await flush();
      expect(h.storage.get(KEY)).toBe(saved);
      expect(href(h)).toBe(destination);
      expect(href(h)).not.toContain('OLD-POST');
      mutations(h);
      await flush();
      expect(posts(h)).toHaveLength(1);
      locked(h);
    }
  );

  it('restores an existing destination on reload without clearing or resending the unknown attempt', async () => {
    const storage = pendingStorage();
    const saved = storage.get(KEY);
    const h = setup({
      storage,
      read: async () => response({ ok: true, record, completion: ready }),
    });
    await flush();
    expect(href(h)).toContain('SAVED-RESULT');
    expect(storage.get(KEY)).toBe(saved);
    mutations(h);
    await flush();
    locked(h);
    expect(posts(h)).toHaveLength(0);
  });

  it('does not lock a different hearing session from this session marker', async () => {
    const storage = pendingStorage();
    storage.set('kyberion.ask.session_id', 'different-session');
    const h = harness({
      query,
      storage,
      hearing: async () =>
        response({ ok: true, record: { ...record, session_id: 'different-session' } }),
    });
    await flush();
    expect(h.elements.get('ask-send')!.disabled).toBe(false);
    expect(h.elements.get('hearing-handoff')!.disabled).toBe(false);
    expect(storage.has(KEY)).toBe(true);
    expect(posts(h)).toHaveLength(0);
  });

  it.each(['write', 'read', 'unretained'])(
    'fails closed before dispatch when marker storage %s fails',
    async (mode) => {
      const h = setup();
      await flush();
      if (mode === 'write')
        h.window.sessionStorage.setItem = () => {
          throw new Error('quota');
        };
      if (mode === 'read')
        h.window.sessionStorage.getItem = () => {
          throw new Error('blocked');
        };
      if (mode === 'unretained') h.window.sessionStorage.setItem = () => h.storage;
      mutations(h);
      await flush();
      expect(posts(h)).toHaveLength(0);
      expect(label(h)).toBe('front_desk:hearing_completion_storage');
      locked(h);
    }
  );

  it.each(['read', 'lost', 'replacement'])(
    'ends the busy UI at the deadline even when storage %s changes while POST never settles',
    async (mode) => {
      vi.useFakeTimers();
      const h = setup();
      await flush();
      click(h);
      await flush();
      if (mode === 'read')
        h.window.sessionStorage.getItem = () => {
          throw new Error('blocked');
        };
      if (mode === 'lost') h.storage.delete(KEY);
      if (mode === 'replacement')
        h.storage.set(KEY, JSON.stringify({ ...marker, operationId: 'replacement' }));
      await vi.advanceTimersByTimeAsync(60000);
      await flush();
      expect(h.elements.get('hearing-completion-status')!.attributes['aria-busy']).toBe('false');
      expect(label(h)).not.toBe('front_desk:hearing_completion_pending');
      mutations(h);
      await flush();
      expect(posts(h)).toHaveLength(1);
      locked(h);
    }
  );

  it.each([0, 60000])(
    'releases the normal read pause when storage retires a completion after %sms',
    async (elapsed) => {
      vi.useFakeTimers();
      const h = setup({
        read: async (number) =>
          response({
            ok: true,
            record: { ...record, canvas_generation: number === 1 ? 'pending' : 'ready' },
            completion: number > 1 ? ready : undefined,
          }),
      });
      await flush();
      click(h);
      await flush();
      await vi.advanceTimersByTimeAsync(elapsed);
      h.browserEvent('storage');
      await vi.advanceTimersByTimeAsync(3000);
      await flush();
      expect(reads(h)).toHaveLength(2);
      expect(href(h)).toContain('SAVED-RESULT');
      expect(h.storage.has(KEY)).toBe(true);
      expect(h.elements.get('hearing-completion-status')!.attributes['aria-busy']).toBe('false');
      expect(posts(h)).toHaveLength(1);
      locked(h);
    }
  );

  it.each([200, 403])(
    'pauses automatic canvas reads until a check retires late POST %s',
    async (status) => {
      vi.useFakeTimers();
      const wait = deferred<Reply>();
      const h = setup({
        post: () => wait.promise,
        read: async (number) =>
          response({
            ok: true,
            record: { ...record, canvas_generation: number === 1 ? 'pending' : 'ready' },
            completion: number > 1 ? ready : undefined,
          }),
      });
      await flush();
      click(h);
      await flush();
      await vi.advanceTimersByTimeAsync(63000);
      await flush();
      expect(reads(h)).toHaveLength(1);
      expect(label(h)).toBe('front_desk:hearing_completion_unknown');
      check(h);
      await flush();
      expect(reads(h)).toHaveLength(2);
      expect(href(h)).toContain('SAVED-RESULT');
      const saved = h.storage.get(KEY);
      wait.resolve(status === 200 ? success('OLD-POST') : response({ ok: false }, status));
      await flush();
      expect(h.storage.get(KEY)).toBe(saved);
      expect(href(h)).toContain('SAVED-RESULT');
      expect(href(h)).not.toContain('OLD-POST');
      mutations(h);
      await flush();
      expect(posts(h)).toHaveLength(1);
      locked(h);
    }
  );

  it.each(['read', 'remove', 'lost', 'replacement'])(
    'does not unlock after storage %s during its POST',
    async (mode) => {
      const wait = deferred<Reply>();
      const h = setup({ post: () => wait.promise });
      await flush();
      click(h);
      await flush();
      const replacement = JSON.stringify({ ...marker, operationId: 'replacement' });
      if (mode === 'read')
        h.window.sessionStorage.getItem = () => {
          throw new Error('blocked');
        };
      if (mode === 'remove')
        h.window.sessionStorage.removeItem = () => {
          throw new Error('blocked');
        };
      if (mode === 'lost') h.storage.delete(KEY);
      if (mode === 'replacement') h.storage.set(KEY, replacement);
      wait.resolve(success());
      await flush();
      mutations(h);
      await flush();
      expect(posts(h)).toHaveLength(1);
      expect(href(h)).toBe('');
      locked(h);
      if (mode === 'replacement') expect(h.storage.get(KEY)).toBe(replacement);
    }
  );

  it.each(['', 'not JSON', '{"version":2}'])(
    'blocks all mutations for malformed marker %j',
    async (value) => {
      const storage = pendingStorage();
      storage.set(KEY, value);
      const h = setup({ storage });
      await flush();
      mutations(h);
      check(h);
      await flush();
      expect(storage.get(KEY)).toBe(value);
      expect(posts(h)).toHaveLength(0);
      expect(reads(h)).toHaveLength(1);
      locked(h);
    }
  );

  it.each(['scope', 'scenarioId', 'conversationId', 'kind'])(
    'does not check a marker from another %s',
    async (field) => {
      const storage = pendingStorage();
      storage.set(
        KEY,
        JSON.stringify({
          ...marker,
          [field]: field === 'kind' ? (kind === 'mission' ? 'inventory' : 'mission') : 'other',
        })
      );
      const h = setup({ storage });
      await flush();
      check(h);
      mutations(h);
      await flush();
      expect(reads(h)).toHaveLength(1);
      expect(posts(h)).toHaveLength(0);
      locked(h);
    }
  );

  it.each(['scope', 'shell', 'pagehide', 'popstate', 'storage', 'replacement', 'lost'])(
    'does not publish a GET destination when %s changes during lookup',
    async (mode) => {
      vi.useFakeTimers();
      const wait = deferred<Reply>();
      const h = setup({
        storage: pendingStorage(),
        read: async (number) => (number === 1 ? response({ ok: true, record }) : wait.promise),
      });
      await flush();
      check(h);
      await flush();
      expect(reads(h)).toHaveLength(2);
      if (mode === 'scope') {
        h.window.location.search = '?mode=hearing&projectId=other';
        h.window.location.href = 'http://localhost/ask' + h.window.location.search;
      }
      if (mode === 'shell') h.shell('blocked', 'Different scope');
      if (mode === 'pagehide') h.browserEvent('pagehide');
      if (mode === 'popstate') h.browserEvent('popstate');
      if (mode === 'storage') h.browserEvent('storage');
      if (mode === 'replacement')
        h.storage.set(KEY, JSON.stringify({ ...marker, operationId: 'replacement' }));
      if (mode === 'lost') h.storage.delete(KEY);
      wait.resolve(response({ ok: true, record, completion: ready }));
      await flush();
      expect(href(h)).toBe('');
      mutations(h);
      await flush();
      expect(posts(h)).toHaveLength(0);
      locked(h);
    }
  );

  it('keeps unknown guarded after BFCache and retires the old POST after the restored GET', async () => {
    vi.useFakeTimers();
    const wait = deferred<Reply>();
    const h = setup({ post: () => wait.promise });
    await flush();
    click(h);
    await flush();
    h.browserEvent('pagehide');
    h.browserEvent('pageshow', { persisted: true });
    h.browserEvent('popstate');
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(reads(h).length).toBeGreaterThan(1);
    wait.resolve(success('RETIRED'));
    await flush();
    expect(href(h)).toBe('');
    expect(h.storage.has(KEY)).toBe(true);
    mutations(h);
    await flush();
    expect(posts(h)).toHaveLength(1);
    locked(h);
  });
});

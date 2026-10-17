import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { safeReadFile } from '@agent/core/secure-io';

const SESSION = 'session-a';
const REQUEST = '00000000-0000-4000-8000-000000000001';
const KEY = 'kyberion.ask.hearing.pending.' + SESSION;
const CONVERSATION = 'concierge-' + 'a'.repeat(64);
const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function record(sourceTurn?: string) {
  return {
    session_id: SESSION,
    scenario: 'web_app_build',
    requirements: [{ id: 'goal', answer: 'Saved', source_turn: sourceTurn }],
    canvas_generation: 'template',
  };
}
function response(value = record(REQUEST)) {
  return { ok: true, status: 200, json: async () => ({ ok: true, record: value }) };
}
function pending(overrides = {}) {
  return {
    requestId: REQUEST,
    conversationId: CONVERSATION,
    scope: '/api/conversation?tenant=alpha',
    scenarioId: 'web_app_build',
    ...overrides,
  };
}
function harness(storage = new Map<string, string>(), overrides = {}) {
  vi.useFakeTimers();
  if (!storage.has('kyberion.ask.session_id')) storage.set('kyberion.ask.session_id', SESSION);
  const elements = new Map(
    ['hearing-sync-status', 'hearing-sync-text', 'hearing-sync-retry', 'hearing-sync-continue'].map(
      (id) => [
        id,
        {
          hidden: true,
          disabled: false,
          textContent: '',
          attributes: {} as Record<string, string>,
          listeners: {} as Record<string, () => void>,
          setAttribute(key: string, value: string) {
            this.attributes[key] = value;
          },
          addEventListener(key: string, callback: () => void) {
            this.listeners[key] = callback;
          },
        },
      ]
    )
  );
  const state = {
    hearingMode: true,
    sessionId: SESSION,
    conversationId: CONVERSATION as string | null,
    hearingScenarioId: 'web_app_build',
    locale: 'en',
    vocab: {},
    hearingRecord: null as ReturnType<typeof record> | null,
    draftShellReady: true,
    historyState: 'ready',
    hearingCanvasPollTries: 0,
    draftScopeEpoch: 0,
    ...overrides,
  };
  const listeners: Record<string, Array<(event?: { persisted: boolean }) => void>> = {};
  const shellListeners: Array<(event: { phase: string }) => void> = [];
  let scope = 'alpha';
  type Helper = {
    blocked: () => boolean;
    submit: (text: string, intent?: unknown) => Promise<unknown>;
    load: () => Promise<unknown>;
    mount: () => void;
    render: () => void;
  };
  const window = {
    location: { pathname: '/ask', search: '?mode=hearing&tenant=alpha', hash: '' },
    sessionStorage: {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        storage.delete(key);
      }),
    },
    setTimeout,
    clearTimeout,
    AbortController,
    addEventListener: (event: string, callback: (event?: { persisted: boolean }) => void) => {
      (listeners[event] ||= []).push(callback);
    },
    FrontDeskRail: {
      ready: Promise.resolve(),
      subscribe: (callback: (event: { phase: string }) => void) => shellListeners.push(callback),
    },
    KyberionAskHearingRecovery: undefined as undefined | { create: (options: unknown) => Helper },
  };
  const fetch = vi
    .fn<(url: string, init?: RequestInit) => Promise<ReturnType<typeof response>>>()
    .mockResolvedValue(response());
  const fetchReadJson = vi.fn(async (url: string) => {
    const result = await fetch(url, { cache: 'no-store' });
    return { ok: result.ok, status: result.status, body: await result.json() };
  });
  const vt = vi.fn((_vocab: unknown, key: string) => key);
  const render = vi.fn();
  const renderHearing = vi.fn();
  runInNewContext(
    String(
      safeReadFile('presence/displays/presence-studio/static/ask-hearing-recovery.js', {
        encoding: 'utf8',
      })
    ),
    {
      window,
      document: { getElementById: (id: string) => elements.get(id) },
      URLSearchParams,
    }
  );
  if (!window.KyberionAskHearingRecovery) throw new Error('Hearing recovery helper was not loaded');
  const helper = window.KyberionAskHearingRecovery.create({
    state,
    fetch,
    fetchReadJson,
    scopedUrl: (path: string) => path + (path.includes('?') ? '&' : '?') + 'tenant=' + scope,
    vt,
    render,
    renderHearing,
    randomId: () => REQUEST,
  });
  helper.mount();
  return {
    helper,
    state,
    window,
    elements,
    fetch,
    fetchReadJson,
    storage,
    render,
    renderHearing,
    vt,
    scope: (value: string) => {
      scope = value;
    },
    event: (key: string, value?: { persisted: boolean }) =>
      listeners[key]?.forEach((fn) => fn(value)),
    shell: (phase: string) => shellListeners.forEach((fn) => fn({ phase })),
  };
}
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('Ask hearing answer recovery', () => {
  it('persists only correlation metadata before posting, then unlocks an exact confirmed turn', async () => {
    const h = harness();
    h.fetch.mockImplementation(async (_url, init) => {
      expect(JSON.parse(h.storage.get(KEY)!)).toEqual(pending());
      expect(JSON.parse(init!.body as string)).toMatchObject({
        text: 'private answer',
        request_id: REQUEST,
        scenario_id: 'web_app_build',
      });
      return response();
    });
    const done = h.helper.submit('private answer', { kind: 'request' });
    expect(h.helper.blocked()).toBe(true);
    await done;
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.helper.blocked()).toBe(false);
    expect(h.storage.has(KEY)).toBe(false);
    expect(h.state.hearingRecord?.requirements[0].source_turn).toBe(REQUEST);
    expect(h.elements.get('hearing-sync-status')!.hidden).toBe(true);
  });

  it.each(['headers', 'body'])(
    'bounds stalled POST %s and keeps the durable lock without replay',
    async (stage) => {
      const h = harness();
      const never = new Promise<never>(() => {});
      h.fetch.mockImplementation(() =>
        stage === 'headers' ? never : Promise.resolve({ ...response(), json: () => never })
      );
      const done = h.helper.submit('answer');
      await flush();
      expect(h.elements.get('hearing-sync-status')!.attributes['aria-busy']).toBe('true');
      await vi.advanceTimersByTimeAsync(60001);
      await done;
      expect(h.helper.blocked()).toBe(true);
      expect(h.elements.get('hearing-sync-status')!.attributes['aria-busy']).toBe('false');
      expect(h.elements.get('hearing-sync-text')!.textContent).toBe(
        'front_desk:hearing_sync_unconfirmed'
      );
      expect(h.elements.get('hearing-sync-retry')!.disabled).toBe(false);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(h.window.sessionStorage.removeItem).not.toHaveBeenCalled();
    }
  );

  it('treats ok/no-op POST as unconfirmed and never resends a second answer', async () => {
    const h = harness();
    h.fetch.mockResolvedValue(response(record('other-turn')));
    await h.helper.submit('first');
    await h.helper.submit('second');
    expect(h.helper.blocked()).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.storage.get(KEY)).toBe(JSON.stringify(pending()));
  });

  it('recovers after reload through GET only and leaves the correlation marker until exact confirmation', async () => {
    const storage = new Map([[KEY, JSON.stringify(pending())]]);
    const h = harness(storage);
    h.fetch.mockResolvedValue(response(record('other')));
    expect(h.helper.blocked()).toBe(true);
    await h.helper.load();
    expect(h.helper.blocked()).toBe(true);
    h.fetch.mockResolvedValue(response());
    await h.helper.load();
    expect(h.helper.blocked()).toBe(false);
    expect(h.fetchReadJson).toHaveBeenCalledTimes(2);
    expect(h.fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it.each(['headers', 'body'])('bounds stalled GET %s at 20 seconds', async (stage) => {
    const h = harness(new Map([[KEY, JSON.stringify(pending())]]));
    const never = new Promise<never>(() => {});
    h.fetch.mockImplementation(() =>
      stage === 'headers' ? never : Promise.resolve({ ...response(), json: () => never })
    );
    const done = h.helper.load();
    await vi.advanceTimersByTimeAsync(20001);
    await done;
    expect(h.helper.blocked()).toBe(true);
    expect(h.elements.get('hearing-sync-retry')!.disabled).toBe(false);
    expect(h.elements.get('hearing-sync-status')!.attributes['aria-busy']).toBe('false');
  });

  it.each(['session', 'scenario', 'source'])(
    'does not unlock a GET with mismatching %s',
    async (mismatch) => {
      const h = harness(new Map([[KEY, JSON.stringify(pending())]]));
      const value = record(mismatch === 'source' ? 'wrong' : REQUEST);
      if (mismatch === 'session') value.session_id = 'other';
      if (mismatch === 'scenario') value.scenario = 'work_inventory';
      h.fetch.mockResolvedValue(response(value));
      await h.helper.load();
      expect(h.helper.blocked()).toBe(true);
      expect(h.storage.has(KEY)).toBe(true);
    }
  );

  it.each(['tenant', 'conversation', 'scenario'])(
    'retains one backend-session lock across a %s change and offers a scoped safe exit',
    async (context) => {
      const h = harness(new Map([[KEY, JSON.stringify(pending())]]));
      if (context === 'tenant') h.scope('beta');
      if (context === 'conversation') h.state.conversationId = 'concierge-' + 'b'.repeat(64);
      if (context === 'scenario') h.state.hearingScenarioId = 'work_inventory';
      await h.helper.load();
      await h.helper.submit('not sent');
      h.helper.render();
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.helper.blocked()).toBe(true);
      expect(h.elements.get('hearing-sync-text')!.textContent).toBe(
        'front_desk:hearing_sync_scope'
      );
      expect(h.elements.get('hearing-sync-continue')!.attributes.href).toBe(
        '/ask?tenant=' + (context === 'tenant' ? 'beta' : 'alpha')
      );
      expect(h.storage.has(KEY)).toBe(true);
    }
  );

  it('does not confuse a not-yet-loaded conversation with a mismatching scope', async () => {
    const h = harness(new Map([[KEY, JSON.stringify(pending())]]), {
      conversationId: null,
      historyState: 'loading',
    });
    await h.helper.load();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.helper.blocked()).toBe(true);
    expect(h.elements.get('hearing-sync-text')!.textContent).not.toBe(
      'front_desk:hearing_sync_scope'
    );
    h.state.conversationId = CONVERSATION;
    h.state.historyState = 'ready';
    await h.helper.load();
    expect(h.helper.blocked()).toBe(false);
  });

  it('deduplicates repeated recheck clicks and never replays a POST', async () => {
    const h = harness(new Map([[KEY, JSON.stringify(pending())]]));
    const wait = deferred<ReturnType<typeof response>>();
    h.fetch.mockReturnValue(wait.promise);
    const first = h.helper.load();
    const second = h.helper.load();
    h.elements.get('hearing-sync-retry')!.listeners.click();
    await flush();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    wait.resolve(response());
    await Promise.all([first, second]);
    expect(h.helper.blocked()).toBe(false);
  });

  it.each(['pagehide', 'popstate', 'hash', 'shell'])(
    'ignores stale POST success after %s',
    async (change) => {
      const h = harness();
      const wait = deferred<ReturnType<typeof response>>();
      h.fetch.mockReturnValue(wait.promise);
      const done = h.helper.submit('answer');
      await flush();
      if (change === 'hash') h.window.location.hash = '#new';
      else if (change === 'shell') {
        h.window.FrontDeskRail.ready = Promise.resolve();
        h.shell('blocked');
      } else h.event(change);
      wait.resolve(response());
      await done;
      expect(h.storage.has(KEY)).toBe(true);
      expect(h.state.hearingRecord).toBe(null);
      expect(h.helper.blocked()).toBe(true);
    }
  );

  it('ignores stale failures after a navigation recheck has confirmed the answer', async () => {
    const h = harness();
    const old = deferred<ReturnType<typeof response>>();
    h.fetch.mockReturnValueOnce(old.promise).mockResolvedValue(response());
    const sending = h.helper.submit('answer');
    await flush();
    h.event('popstate');
    await h.helper.load();
    old.reject(new Error('late failure'));
    await sending;
    expect(h.helper.blocked()).toBe(false);
    expect(h.elements.get('hearing-sync-status')!.hidden).toBe(true);
  });

  it('does not let an older GET overwrite a confirmed POST record', async () => {
    const h = harness();
    const old = deferred<ReturnType<typeof response>>();
    h.fetch.mockReturnValueOnce(old.promise).mockResolvedValue(response());
    const reading = h.helper.load();
    await flush();
    await h.helper.submit('answer');
    old.resolve(response(record('older')));
    await reading;
    expect(h.state.hearingRecord?.requirements[0].source_turn).toBe(REQUEST);
    expect(h.helper.blocked()).toBe(false);
  });

  it.each(['set-throws', 'readback', 'session'])(
    'prevents POST when durable storage verification fails: %s',
    async (failure) => {
      const h = harness();
      if (failure === 'set-throws')
        h.window.sessionStorage.setItem.mockImplementation(() => {
          throw new Error('blocked');
        });
      if (failure === 'readback') h.window.sessionStorage.setItem.mockImplementation(() => {});
      if (failure === 'session') h.storage.delete('kyberion.ask.session_id');
      await h.helper.submit('private answer');
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.helper.blocked()).toBe(true);
      expect(h.elements.get('hearing-sync-text')!.textContent).toBe(
        'front_desk:hearing_sync_storage'
      );
      expect(h.elements.get('hearing-sync-continue')!.hidden).toBe(false);
    }
  );

  it.each(['{broken', '{}', JSON.stringify({ ...pending(), text: 'answer' })])(
    'fails closed on malformed saved data without deleting it',
    async (value) => {
      const h = harness(new Map([[KEY, value]]));
      await h.helper.load();
      await h.helper.submit('new');
      expect(h.helper.blocked()).toBe(true);
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.storage.get(KEY)).toBe(value);
      expect(h.window.sessionStorage.removeItem).not.toHaveBeenCalled();
    }
  );

  it('checks clear ownership and does not remove a newer marker', async () => {
    const h = harness();
    const wait = deferred<ReturnType<typeof response>>();
    h.fetch.mockReturnValue(wait.promise);
    const done = h.helper.submit('answer');
    await flush();
    h.storage.set(KEY, JSON.stringify(pending({ requestId: 'newer-request' })));
    wait.resolve(response());
    await done;
    expect(h.helper.blocked()).toBe(true);
    expect(JSON.parse(h.storage.get(KEY)!).requestId).toBe('newer-request');
    expect(h.window.sessionStorage.removeItem).not.toHaveBeenCalled();
  });

  it('retains the lock if removing the confirmed marker fails verification', async () => {
    const h = harness();
    h.window.sessionStorage.removeItem.mockImplementation(() => {});
    await h.helper.submit('answer');
    expect(h.helper.blocked()).toBe(true);
    expect(h.storage.has(KEY)).toBe(true);
    expect(h.elements.get('hearing-sync-text')!.textContent).toBe(
      'front_desk:hearing_sync_storage'
    );
  });

  it('allows an ordinary Ask exit without dropping the hearing marker', async () => {
    const h = harness(new Map([[KEY, JSON.stringify(pending())]]));
    h.state.hearingMode = false;
    h.window.location.search = '?tenant=alpha';
    await h.helper.load();
    expect(h.helper.blocked()).toBe(false);
    expect(h.storage.has(KEY)).toBe(true);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('retains and rechecks a marker after persisted pageshow once history is ready', async () => {
    const h = harness(new Map([[KEY, JSON.stringify(pending())]]));
    h.event('pagehide');
    h.state.historyState = 'loading';
    h.event('pageshow', { persisted: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetch).not.toHaveBeenCalled();
    h.state.historyState = 'ready';
    await h.helper.load();
    expect(h.fetchReadJson).toHaveBeenCalledTimes(1);
    expect(h.helper.blocked()).toBe(false);
  });

  it('bounds optional canvas polling to ten three-second reads', async () => {
    const h = harness();
    h.fetch.mockResolvedValue(response({ ...record(), canvas_generation: 'pending' }));
    await h.helper.load();
    await vi.advanceTimersByTimeAsync(30001);
    expect(h.fetchReadJson).toHaveBeenCalledTimes(11);
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.fetchReadJson).toHaveBeenCalledTimes(11);
  });
  it.each(['post', 'get'])(
    'ignores late %s confirmation after its bounded wait expires',
    async (method) => {
      const h = harness(method === 'get' ? new Map([[KEY, JSON.stringify(pending())]]) : undefined);
      const wait = deferred<ReturnType<typeof response>>();
      h.fetch.mockReturnValue(wait.promise);
      const done = method === 'post' ? h.helper.submit('answer') : h.helper.load();
      await vi.advanceTimersByTimeAsync(method === 'post' ? 60001 : 20001);
      await done;
      wait.resolve(response());
      await flush();
      expect(h.helper.blocked()).toBe(true);
      expect(h.state.hearingRecord).toBe(null);
      expect(h.storage.has(KEY)).toBe(true);
      if (method === 'post') expect(h.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    }
  );

  it('retains recovery across locale, hash, and volatile shell-epoch changes', async () => {
    const h = harness(new Map([[KEY, JSON.stringify(pending())]]));
    h.state.locale = 'ja';
    h.state.draftScopeEpoch += 1;
    h.window.location.hash = '#restored';
    await h.helper.load();
    expect(h.helper.blocked()).toBe(false);
    expect(h.fetchReadJson).toHaveBeenCalledWith(
      '/api/hearing/session-a?locale=ja&scenario_id=web_app_build&tenant=alpha'
    );
  });

  it('ignores stale GET success after navigation, then recovers from a fresh read', async () => {
    const h = harness(new Map([[KEY, JSON.stringify(pending())]]));
    const old = deferred<ReturnType<typeof response>>();
    h.fetch.mockReturnValueOnce(old.promise).mockResolvedValue(response());
    const reading = h.helper.load();
    await flush();
    h.event('popstate');
    old.resolve(response());
    await reading;
    expect(h.helper.blocked()).toBe(true);
    expect(h.state.hearingRecord).toBe(null);
    await h.helper.load();
    expect(h.helper.blocked()).toBe(false);
  });

  it('lets a source-scope GET recover after a scope mismatch without resubmission', async () => {
    const h = harness(new Map([[KEY, JSON.stringify(pending())]]));
    h.scope('beta');
    await h.helper.load();
    expect(h.fetch).not.toHaveBeenCalled();
    h.scope('alpha');
    await h.helper.load();
    expect(h.helper.blocked()).toBe(false);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('leaves malformed response records locked and retryable', async () => {
    const h = harness(new Map([[KEY, JSON.stringify(pending())]]));
    h.fetch.mockResolvedValue({
      ...response(),
      json: async () => ({ ok: true, record: { ...record(), requirements: null! } }),
    });
    await h.helper.load();
    expect(h.helper.blocked()).toBe(true);
    expect(h.state.hearingRecord).toBe(null);
    expect(h.elements.get('hearing-sync-retry')!.disabled).toBe(false);
  });
  it('calls native fetch without binding the helper options as its receiver', async () => {
    const h = harness();
    h.fetch.mockImplementation(async function (this: unknown) {
      if (this !== undefined) throw new TypeError('Illegal invocation');
      return response();
    });
    await h.helper.submit('answer');
    expect(h.helper.blocked()).toBe(false);
    expect(h.state.hearingRecord?.requirements[0].source_turn).toBe(REQUEST);
  });
  it('keeps server-rendered recovery copy until translated vocabulary is available', () => {
    const h = harness(new Map([[KEY, JSON.stringify(pending())]]));
    for (const id of ['hearing-sync-text', 'hearing-sync-retry', 'hearing-sync-continue'])
      h.elements.get(id)!.textContent = 'Server-rendered ' + id;
    h.vt.mockReturnValue('');
    h.helper.render();
    for (const id of ['hearing-sync-text', 'hearing-sync-retry', 'hearing-sync-continue'])
      expect(h.elements.get(id)!.textContent).toBe('Server-rendered ' + id);
  });
});

it.each(['stale_snapshot', 'completion_locked', 'handoff_unresolved'])(
  'explains answer %s without replaying or claiming the pending answer succeeded',
  async (code) => {
    const h = harness();
    h.fetch.mockResolvedValueOnce({
      ...response(),
      ok: false,
      status: 409,
      json: async () => ({ ok: false, record: record(), hearing_conflict: code }),
    });
    await h.helper.submit('Private answer');
    expect(h.elements.get('hearing-sync-text')!.textContent).toContain(
      'front_desk:hearing_conflict_' + code
    );
    expect(h.storage.has(KEY)).toBe(true);
    expect(h.helper.blocked()).toBe(true);
    await h.helper.submit('Do not replay');
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.fetch.mockResolvedValueOnce(response(record()));
    await h.helper.load();
    expect(h.storage.has(KEY)).toBe(true);
    expect(h.elements.get('hearing-sync-text')!.textContent).toContain(
      'front_desk:hearing_conflict_' + code
    );
  }
);

it('does not publish a retired answer conflict after scope navigation', async () => {
  const h = harness();
  const d = deferred<ReturnType<typeof response>>();
  h.fetch.mockReturnValueOnce(d.promise);
  const waiting = h.helper.submit('Private answer');
  await flush();
  h.scope('beta');
  h.shell('blocked');
  d.resolve({
    ...response(),
    ok: false,
    status: 409,
    json: async () => ({ ok: false, record: record(), hearing_conflict: 'stale_snapshot' }),
  });
  await waiting;
  expect(h.elements.get('hearing-sync-text')!.textContent).not.toContain('hearing_conflict');
  expect(h.storage.has(KEY)).toBe(true);
});

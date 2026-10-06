import { describe, it, expect, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { safeReadFile } from '@agent/core/secure-io';

// Focused DOM doubles, not a visual or running-server browser test.
class Element {
  value = '';
  private ownText = '';
  children: Element[] = [];
  disabled = false;
  hidden = false;
  className = '';
  type = '';
  attributes: Record<string, string> = {};
  listeners: Record<string, () => void> = {};
  constructor(readonly tagName = 'div') {}
  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join(' ');
  }
  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }
  set innerHTML(_value: string) {
    throw new Error('Untrusted HTML is forbidden');
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  appendChild(child: Element) {
    this.children.push(child);
    return child;
  }
  replaceChildren() {
    this.children = [];
    this.ownText = '';
  }
  addEventListener(name: string, handler: () => void) {
    this.listeners[name] = handler;
  }
  fire(event = 'click') {
    this.listeners[event]?.();
  }
  descendants(): Element[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}
const session = 'concierge-' + 'a'.repeat(64);
const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const sha256 = 'a'.repeat(64);
const storageKey = 'kyberion.first-job.v1';
const reply = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  readiness: { status: 'diagnostic_mapping_ready', ready: true },
  sessionId: session,
  pending: 0,
  tasks: [],
  messages: [],
  next_action: 'start',
  ...overrides,
});
const artifact = (overrides: Record<string, unknown> = {}) => ({
  requestId: first,
  revision: 1,
  format: 'readable',
  sha256,
  verification: 'verified',
  currentness: 'latest_verified',
  verifiedAt: 1234567890000,
  ...overrides,
});
function harness(
  options: {
    storage?: Map<string, string>;
    storageThrows?: boolean;
    cryptoMissing?: boolean;
    approvalReady?: boolean;
    heldRequests?: Array<{ request_id: string; status: string; recovery: string }>;
    ready?: Promise<void>;
    hidden?: boolean;
    get?: () => ReturnType<typeof reply> | Promise<ReturnType<typeof reply>>;
    body?: (query: URLSearchParams) => ReturnType<typeof reply> | Promise<ReturnType<typeof reply>>;
    post?: (body: Record<string, unknown>) => Promise<ReturnType<typeof reply>>;
    vocabularyFails?: boolean;
  } = {}
) {
  const elements = new Map(
    [
      'readiness',
      'scope',
      'advance',
      'tick',
      'setup',
      'start',
      'refresh',
      'retry',
      'approval',
      'status',
      'error',
      'history',
      'last-checked',
      'refresh-mode',
      'refresh-error',
      'body-retry',
      'compare-status',
      ...['body', 'left', 'right'].flatMap((slot) =>
        ['select', 'metadata', 'status', 'content'].map((part) => slot + '-' + part)
      ),
    ].map((id) => [id, new Element()])
  );
  elements.get('error')!.textContent = 'Server-rendered load failure';
  const storage = options.storage ?? new Map<string, string>();
  const timers = new Map<number, { at: number; handler: () => void }>();
  const documentListeners: Record<string, () => void> = {};
  const windowListeners: Record<string, () => void> = {};
  let now = 0;
  let timerId = 0;
  const window = {
    AbortController,
    addEventListener: (event: string, handler: () => void) => {
      windowListeners[event] = handler;
    },
    setTimeout(handler: () => void, delay: number) {
      const id = ++timerId;
      timers.set(id, { at: now + delay, handler });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    location: {
      search: '?tenant=attacker&action=start&text=ignore',
      href: 'http://localhost/first-job',
    },
    crypto: options.cryptoMissing ? undefined : { randomUUID },
    sessionStorage: {
      getItem(key: string) {
        if (options.storageThrows) throw new Error('denied');
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        if (options.storageThrows) throw new Error('denied');
        storage.set(key, value);
      },
    },
    KyberionFirstJobApproval: {
      check: async (context: {
        onChange: (status: {
          ready: boolean;
          busy: boolean;
          heldRequests?: Array<{ request_id: string; status: string; recovery: string }>;
        }) => void;
      }) =>
        context.onChange({
          ready: options.approvalReady !== false,
          busy: false,
          heldRequests: options.heldRequests,
        }),
      invalidate: vi.fn(),
    },
    KyberionPrefs: { locale: () => 'en' },
    FrontDeskRail: { ready: options.ready ?? Promise.resolve() },
    KyberionFirstJob: undefined as undefined | { mount: () => void },
  };
  const fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST')
      return options.post
        ? options.post(JSON.parse(init.body!))
        : reply(snapshot({ historySaved: true }));
    if (url.startsWith('/api/ui-vocabulary')) {
      if (options.vocabularyFails) throw new Error('offline');
      const texts = new Proxy({}, { get: (_target, key) => String(key) });
      return reply({ ok: true, texts });
    }
    if (url.startsWith('/api/first-job/artifact?')) {
      const query = new URLSearchParams(url.split('?')[1]);
      return options.body
        ? options.body(query)
        : reply({
            ok: true,
            sessionId: query.get('session_id'),
            artifact: artifact({
              requestId: query.get('request_id'),
              revision: Number(query.get('revision')),
              sha256: query.get('sha256'),
              body: '{"diagnostic":"verified"}\n',
            }),
          });
    }
    if (url.startsWith('/api/first-job?')) return options.get ? options.get() : reply(snapshot());
    throw new Error('Unexpected fetch ' + url);
  });
  const document = {
    hidden: options.hidden === true,
    visibilityState: options.hidden ? 'hidden' : 'visible',
    addEventListener: (event: string, handler: () => void) => {
      documentListeners[event] = handler;
    },
    documentElement: { getAttribute: () => 'en' },
    getElementById: (id: string) => elements.get(id.replace('first-job-', '')) ?? null,
    createElement: (tag: string) => new Element(tag),
  };
  runInNewContext(
    String(
      safeReadFile('presence/displays/presence-studio/static/first-job.js', { encoding: 'utf8' })
    ),
    { window, document, fetch, URLSearchParams }
  );
  window.KyberionFirstJob!.mount();
  const get = (id: string) => elements.get(id)!;
  const posts = () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
  const reads = () => fetch.mock.calls.filter(([url]) => url.startsWith('/api/first-job?'));
  const bodies = () =>
    fetch.mock.calls.filter(([url]) => url.startsWith('/api/first-job/artifact?'));
  const advance = async (ms: number) => {
    const end = now + ms;
    while (true) {
      const next = [...timers]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].handler();
      await flush();
    }
    now = end;
  };
  const visibility = (hidden: boolean) => {
    document.hidden = hidden;
    document.visibilityState = hidden ? 'hidden' : 'visible';
    documentListeners.visibilitychange?.();
  };
  const page = (event: string) => windowListeners[event]?.();
  return { get, window, storage, fetch, posts, reads, bodies, advance, visibility, page, timers };
}

describe('First-job bounded browser flow (DOM doubles)', () => {
  it('waits for navigation readiness, reads only on load and ignores query commands and scope', async () => {
    const ready = deferred<void>();
    const h = harness({ ready: ready.promise });
    await flush();
    expect(h.fetch).not.toHaveBeenCalled();
    ready.resolve();
    await flush();
    expect(h.posts()).toHaveLength(0);
    expect(h.fetch.mock.calls.map(([url]) => url).join(' ')).not.toMatch(
      /tenant|attacker|action=start|text=/
    );
    expect(h.get('start').disabled).toBe(false);
    expect(h.get('readiness').textContent).toContain('first_job_ready');
  });

  it.each([
    'mapping_missing',
    'mapping_mismatch',
    'mapping_ambiguous',
    'mapping_unavailable',
    'mapping_changed',
  ])('fails closed for %s and shows setup guidance', async (status) => {
    const h = harness({ get: () => reply(snapshot({ readiness: { status, ready: false } })) });
    await flush();
    h.get('start').fire();
    await flush();
    expect(h.get('setup').hidden).toBe(false);
    expect(h.get('readiness').textContent).toContain(status);
    expect(h.get('start').disabled).toBe(true);
    expect(h.posts()).toHaveLength(0);
  });

  it('does not mistake an unknown ready-labelled response for the bounded setup', async () => {
    const h = harness({
      get: () => reply(snapshot({ readiness: { status: 'ready', ready: true } })),
    });
    await flush();
    expect(h.get('start').disabled).toBe(true);
  });

  it('sends only on click, coalesces repeated clicks, and persists the exact UUID before sending', async () => {
    const pending = deferred<ReturnType<typeof reply>>();
    const h = harness({
      post: async (body) => {
        expect(JSON.parse(h.storage.get(storageKey)!).pending.body).toEqual(body);
        return pending.promise;
      },
    });
    await flush();
    h.get('start').fire();
    h.get('start').fire();
    await flush();
    expect(h.posts()).toHaveLength(1);
    const body = JSON.parse(h.posts()[0][1]!.body!);
    expect(Object.keys(body).sort()).toEqual(['action', 'locale', 'request_id', 'session_id']);
    expect(body).toMatchObject({ action: 'start', session_id: session, locale: 'en' });
    expect(body.request_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(h.get('refresh').disabled).toBe(true);
    pending.resolve(
      reply(
        snapshot({
          historySaved: true,
          tasks: [
            {
              executionStatus: 'awaiting_approval',
              artifact: artifact({
                requestId: body.request_id,
                verification: 'pending',
                currentness: 'requested_pending',
              }),
            },
          ],
        })
      )
    );
    await flush();
    expect(h.get('approval').hidden).toBe(false);
    expect(h.get('start').disabled).toBe(true);
    expect(JSON.parse(h.storage.get(storageKey)!).pending).toBeNull();
  });

  it('never replays a lost-response request on reload and clears uncertainty only after observing its saved task', async () => {
    const storage = new Map<string, string>();
    const h = harness({
      storage,
      post: async () => {
        throw new Error('lost response');
      },
    });
    await flush();
    h.get('start').fire();
    await flush();
    const requestId = JSON.parse(storage.get(storageKey)!).pending.body.request_id;
    const loaded = harness({ storage });
    await flush();
    expect(loaded.posts()).toHaveLength(0);
    expect(loaded.get('start').disabled).toBe(true);
    expect(loaded.get('retry').hidden).toBe(true);
    expect(loaded.get('error').textContent).toContain('uncertain');
    const observed = harness({
      storage,
      get: () =>
        reply(
          snapshot({
            tasks: [{ artifact: artifact({ requestId }), executionStatus: 'work_completed' }],
          })
        ),
    });
    await flush();
    expect(observed.posts()).toHaveLength(0);
    expect(JSON.parse(storage.get(storageKey)!).pending).toBeNull();
    expect(observed.get('error').hidden).toBe(true);
  });

  it('requires a read refresh and explicit click before retrying a confirmed-safe error with the same ID', async () => {
    const h = harness({ post: async () => reply({ ok: false, retry_safe: true }, 409) });
    await flush();
    h.get('start').fire();
    await flush();
    expect(h.get('retry').disabled).toBe(true);
    h.get('retry').fire();
    expect(h.posts()).toHaveLength(1);
    h.get('refresh').fire();
    await flush();
    expect(h.get('retry').disabled).toBe(false);
    h.get('retry').fire();
    await flush();
    expect(h.posts()).toHaveLength(2);
    expect(h.posts()[1][1]!.body).toBe(h.posts()[0][1]!.body);
  });

  it.each([{ storageThrows: true }, { cryptoMissing: true }])(
    'fails closed when safe resumption is unavailable: %j',
    async (options) => {
      const h = harness(options);
      await flush();
      h.get('start').fire();
      expect(h.posts()).toHaveLength(0);
      expect(h.get('error').textContent).toContain('storage_required');
      expect(h.get('start').disabled).toBe(true);
    }
  );

  it('retains earlier verified receipts and revises only the server-authorized current receipt', async () => {
    const h = harness({
      get: () =>
        reply(
          snapshot({
            tasks: [
              {
                artifact: artifact({ currentness: 'older_verified' }),
                executionStatus: 'work_completed',
              },
              {
                artifact: artifact({ requestId: second, revision: 2 }),
                executionStatus: 'work_completed',
                title: '/private/path',
                resultExcerpt: '<script>bad</script>',
              },
            ],
            messages: [
              {
                role: 'secretary',
                text: '/private/path <script>bad</script>',
                artifact: {
                  requestId: second,
                  revision: 2,
                  sha256,
                  format: 'readable',
                  canRevise: true,
                },
              },
            ],
          })
        ),
    });
    await flush();
    const history = h.get('history');
    expect(history.children).toHaveLength(2);
    expect(history.textContent).toContain(first);
    expect(history.textContent).toContain(second);
    expect(history.textContent).not.toMatch(/private|script|bad/);
    const buttons = history.descendants().filter((node) => node.tagName === 'button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].disabled).toBe(false);
    buttons[0].fire();
    await flush();
    const body = JSON.parse(h.posts()[0][1]!.body!);
    expect(body.action).toBe('revise');
    expect(body.artifactRevision).toEqual({
      requestId: second,
      revision: 2,
      sha256,
      format: 'compact',
    });
    expect(body.request_id).not.toBe(second);
    expect(h.posts().every(([url]) => url === '/api/first-job')).toBe(true);
  });

  it.each([false, undefined])(
    'never offers revision without canRevise=true (%s)',
    async (canRevise) => {
      const h = harness({
        get: () =>
          reply(
            snapshot({
              tasks: [{ artifact: artifact(), executionStatus: 'work_completed' }],
              messages: [
                {
                  role: 'secretary',
                  artifact: {
                    requestId: first,
                    revision: 1,
                    sha256,
                    format: 'readable',
                    canRevise,
                  },
                },
              ],
            })
          ),
      });
      await flush();
      expect(
        h
          .get('history')
          .descendants()
          .filter((node) => node.tagName === 'button')
      ).toHaveLength(0);
    }
  );

  it('does not call an answered but unverified task completed', async () => {
    const h = harness({
      get: () =>
        reply(
          snapshot({
            tasks: [
              {
                sourceStatus: 'answered',
                executionStatus: 'work_completed',
                artifact: artifact({ verification: 'unknown' }),
              },
            ],
          })
        ),
    });
    await flush();
    expect(h.get('history').textContent).toContain('first_job_status_unknown');
    expect(h.get('history').textContent).not.toContain('first_job_status_work_completed');
  });

  it('keeps localized server-rendered failure copy when vocabulary fails', async () => {
    const h = harness({ vocabularyFails: true });
    await flush();
    expect(h.get('error').hidden).toBe(false);
    expect(h.get('status').textContent).toBe('Server-rendered load failure');
    expect(h.get('start').disabled).toBe(true);
    expect(h.posts()).toHaveLength(0);
  });

  it('disables mutation after an authentication or history failure', async () => {
    const h = harness({ get: () => reply({ ok: false }, 401) });
    await flush();
    expect(h.get('start').disabled).toBe(true);
    expect(h.get('error').textContent).toContain('load_failed');
    h.get('start').fire();
    expect(h.posts()).toHaveLength(0);
  });

  it('keeps the request uncertain when a success response has no matching saved task', async () => {
    const h = harness();
    await flush();
    h.get('start').fire();
    await flush();
    expect(h.get('start').disabled).toBe(true);
    expect(h.get('error').textContent).toContain('uncertain');
    h.get('start').fire();
    expect(h.posts()).toHaveLength(1);
  });

  it('keeps malformed saved pending work inert rather than silently creating a replacement', async () => {
    const storage = new Map([[storageKey, JSON.stringify({ sessionId: session, pending: {} })]]);
    const h = harness({ storage });
    await flush();
    h.get('start').fire();
    expect(JSON.parse(storage.get(storageKey)!).pending).toEqual({});
    expect(h.get('start').disabled).toBe(true);
    expect(h.posts()).toHaveLength(0);
    expect(h.get('error').textContent).toContain('storage_required');
  });

  it('shows uncertainty for a newer unverified request even when an earlier receipt is verified', async () => {
    const h = harness({
      get: () =>
        reply(
          snapshot({
            tasks: [
              {
                artifact: artifact({ currentness: 'older_verified' }),
                executionStatus: 'work_completed',
              },
              {
                artifact: artifact({
                  requestId: second,
                  revision: 2,
                  verification: 'unknown',
                  currentness: 'requested_unknown',
                }),
                executionStatus: 'uncertain',
              },
            ],
          })
        ),
    });
    await flush();
    expect(h.get('status').textContent).toContain('uncertain');
    expect(h.get('start').disabled).toBe(true);
    expect(h.get('history').children).toHaveLength(2);
  });

  it('shows bounded terminal advance guidance using only the server test tenant', async () => {
    const h = harness({
      get: () =>
        reply(
          snapshot({
            scope: { tenant: 'onboarding-test', tier: 'public' },
            tasks: [
              {
                executionStatus: 'queued',
                artifact: artifact({ verification: 'pending', currentness: 'requested_pending' }),
              },
            ],
          })
        ),
    });
    await flush();
    expect(h.get('scope').textContent).toContain('onboarding-test');
    expect(h.get('scope').textContent).not.toMatch(/all|undefined/);
    expect(h.get('advance').hidden).toBe(false);
    expect(h.get('tick').textContent).toBe(
      'pnpm onboarding first-job --tenant onboarding-test --tick'
    );
    expect(h.posts()).toHaveLength(0);
  });

  it('does not unlock first work solely from a ready local mapping without verified approval eligibility', async () => {
    const h = harness({ approvalReady: false });
    await flush();
    h.get('start').fire();
    expect(h.get('readiness').textContent).toContain('first_job_ready');
    expect(h.get('start').disabled).toBe(true);
    expect(h.posts()).toHaveLength(0);
  });

  it('keeps a held old request disabled and requires operator recovery without offering a new request', async () => {
    const heldRequests = [
      { request_id: first, status: 'approval_verification_failed', recovery: 'operator_recovery' },
    ];
    const h = harness({
      heldRequests,
      get: () =>
        reply(
          snapshot({
            scope: { tenant: 'test-tenant', tier: 'public' },
            tasks: [
              {
                executionStatus: 'awaiting_approval',
                artifact: artifact({ verification: 'pending', currentness: 'requested_pending' }),
              },
            ],
          })
        ),
    });
    await flush();
    expect(h.posts()).toHaveLength(0);
    expect(h.get('start').disabled).toBe(true);
    expect(h.get('status').textContent).toContain('approval_held');
    expect(h.get('advance').hidden).toBe(true);
    expect(h.get('history').textContent).not.toContain('status_awaiting_approval');
    h.get('start').fire();
    h.get('refresh').fire();
    await flush();
    h.get('start').fire();
    await flush();
    expect(h.posts()).toHaveLength(0);
    expect(h.get('start').disabled).toBe(true);
    expect(h.get('history').children).toHaveLength(1);
    expect(h.get('history').textContent).toContain(first);
    const html = String(
      safeReadFile('presence/displays/presence-studio/static/first-job.html', { encoding: 'utf8' })
    );
    const script = String(
      safeReadFile('presence/displays/presence-studio/static/first-job.js', { encoding: 'utf8' })
    );
    expect(html).not.toContain('first-job-new-request');
    expect(script).not.toMatch(/canRecover|new-request/);
  });
});

describe('Verified receipt bodies and immutable comparison (DOM doubles)', () => {
  const receiptKey = (id = first, revision = 1, hash = sha256) => id + ':' + revision + ':' + hash;
  const completed = (overrides: Record<string, unknown> = {}) => ({
    executionStatus: 'work_completed',
    artifact: artifact(overrides),
  });
  const twoVersions = () =>
    snapshot({
      tasks: [
        completed({ currentness: 'older_verified' }),
        completed({ requestId: second, revision: 2 }),
      ],
    });
  const select = (h: ReturnType<typeof harness>, slot: string, key: string) => {
    h.get(slot + '-select').value = key;
    h.get(slot + '-select').fire('change');
  };

  it('loads each exact identity once, displays JSON as literal text, and compares without mutations', async () => {
    const older = '{\n  "value": "<script>bad()</script>",\n  "revision": 1\n}\n';
    const newer = '{"value":"<script>bad()</script>","revision":2}\n';
    const h = harness({
      get: () => reply(twoVersions()),
      body: (query) =>
        reply({
          ok: true,
          sessionId: session,
          artifact: artifact({
            requestId: query.get('request_id'),
            revision: Number(query.get('revision')),
            currentness: query.get('request_id') === first ? 'older_verified' : 'latest_verified',
            body: query.get('request_id') === first ? older : newer,
          }),
        }),
    });
    await flush();
    expect(h.bodies()).toHaveLength(2);
    for (const [url, init] of h.bodies()) {
      const query = new URLSearchParams(url.split('?')[1]);
      expect([...query.keys()].sort()).toEqual(['request_id', 'revision', 'session_id', 'sha256']);
      expect(query.get('session_id')).toBe(session);
      expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
    }
    expect(h.get('body-content').textContent).toBe(newer);
    expect(h.get('left-content').textContent).toBe(older);
    expect(h.get('right-content').textContent).toBe(newer);
    expect(h.get('compare-status').textContent).toContain('compare_different');
    expect(h.get('left-metadata').textContent).toContain(first);
    expect(h.get('left-metadata').textContent).toContain(sha256);
    select(h, 'body', receiptKey());
    h.get('refresh').fire();
    await flush();
    expect(h.get('body-content').textContent).toBe(older);
    expect(h.bodies()).toHaveLength(2);
    expect(h.posts()).toHaveLength(0);
    expect(h.storage.get(storageKey)).not.toContain('bad');
  });

  it('retains all three chosen identities when a newer verified revision arrives', async () => {
    let current = twoVersions();
    const h = harness({ get: () => reply(current) });
    await flush();
    select(h, 'body', receiptKey());
    select(h, 'left', receiptKey(second, 2));
    select(h, 'right', receiptKey());
    const third = '33333333-3333-4333-8333-333333333333';
    current = snapshot({
      tasks: [
        completed({ currentness: 'older_verified' }),
        completed({ requestId: second, revision: 2, currentness: 'older_verified' }),
        completed({ requestId: third, revision: 3 }),
      ],
    });
    h.get('refresh').fire();
    await flush();
    expect(h.get('body-select').value).toBe(receiptKey());
    expect(h.get('left-select').value).toBe(receiptKey(second, 2));
    expect(h.get('right-select').value).toBe(receiptKey());
    expect(h.get('body-metadata').textContent).toContain('first_job_older');
    expect(h.bodies()).toHaveLength(2);
    expect(h.posts()).toHaveLength(0);
  });

  it('clears removed or hash-changed selections without silently following a replacement', async () => {
    let current = twoVersions();
    const oldBody = deferred<ReturnType<typeof reply>>();
    const h = harness({ get: () => reply(current), body: async () => oldBody.promise });
    await flush();
    const original = h.get('body-select').value;
    current = snapshot({
      tasks: [completed({ requestId: second, revision: 2, sha256: 'b'.repeat(64) })],
    });
    h.get('refresh').fire();
    await flush();
    oldBody.resolve(
      reply({
        ok: true,
        sessionId: session,
        artifact: artifact({ requestId: second, revision: 2, body: 'old body must stay hidden' }),
      })
    );
    await flush();
    expect(h.get('body-select').value).toBe(original);
    expect(h.get('body-status').textContent).toContain('body_unavailable');
    expect(h.get('body-content').textContent).toBe('');
    expect(h.get('right-content').textContent).toBe('');
    expect(h.posts()).toHaveLength(0);
  });

  it('ignores a slow previous body when selection changes and deduplicates outstanding reads', async () => {
    const firstBody = deferred<ReturnType<typeof reply>>();
    const secondBody = deferred<ReturnType<typeof reply>>();
    const h = harness({
      get: () => reply(twoVersions()),
      body: (query) => (query.get('request_id') === first ? firstBody.promise : secondBody.promise),
    });
    await flush();
    select(h, 'body', receiptKey());
    select(h, 'right', receiptKey());
    h.get('body-retry').fire();
    expect(h.bodies()).toHaveLength(2);
    firstBody.resolve(
      reply({
        ok: true,
        sessionId: session,
        artifact: artifact({ currentness: 'older_verified', body: '"old"\n' }),
      })
    );
    await flush();
    secondBody.resolve(
      reply({
        ok: true,
        sessionId: session,
        artifact: artifact({ requestId: second, revision: 2, body: '"new"\n' }),
      })
    );
    await flush();
    expect(h.get('body-content').textContent).toBe('"old"\n');
    expect(h.get('right-content').textContent).toBe('"old"\n');
    expect(h.get('compare-status').textContent).toContain('compare_same_version');
    expect(h.posts()).toHaveLength(0);
  });

  it.each([403, 404, 503])(
    'shows no body from a failed %s response and permits only a read retry',
    async (status) => {
      let fail = true;
      const h = harness({
        get: () => reply(snapshot({ tasks: [completed()] })),
        body: () =>
          reply(
            {
              ok: !fail,
              sessionId: session,
              artifact: artifact({ body: '"trusted"\n' }),
              body: '<img src=x onerror=bad()>',
            },
            fail ? status : 200
          ),
      });
      await flush();
      expect(h.get('body-content').textContent).toBe('');
      expect(h.get('body-status').textContent).toContain(
        status === 403 ? 'body_forbidden' : status === 404 ? 'body_unavailable' : 'body_failed'
      );
      expect(h.get('body-retry').disabled).toBe(status === 403);
      fail = false;
      h.get(status === 403 ? 'refresh' : 'body-retry').fire();
      await flush();
      expect(h.get('body-content').textContent).toBe('"trusted"\n');
      expect(h.bodies()).toHaveLength(2);
      expect(h.posts()).toHaveLength(0);
    }
  );

  it.each([
    { sessionId: 'concierge-' + 'b'.repeat(64) },
    { artifact: artifact({ requestId: second, body: 'unsafe' }) },
    { artifact: artifact({ revision: 2, body: 'unsafe' }) },
    { artifact: artifact({ sha256: 'b'.repeat(64), body: 'unsafe' }) },
    { artifact: artifact({ format: 'compact', body: 'unsafe' }) },
    { artifact: artifact({ verification: 'unknown', body: 'unsafe' }) },
    { artifact: artifact({ currentness: 'requested_pending', body: 'unsafe' }) },
    { artifact: artifact({ body: { html: 'unsafe' } }) },
  ])('rejects a response that does not match the verified selection: %j', async (overrides) => {
    const h = harness({
      get: () => reply(snapshot({ tasks: [completed()] })),
      body: () =>
        reply({ ok: true, sessionId: session, artifact: artifact({ body: 'safe' }), ...overrides }),
    });
    await flush();
    expect(h.get('body-content').textContent).toBe('');
    expect(h.get('body-status').textContent).toContain('body_unavailable');
    expect(h.posts()).toHaveLength(0);
  });

  it('never requests bodies for pending, unknown or malformed receipt identities', async () => {
    const h = harness({
      get: () =>
        reply(
          snapshot({
            tasks: [
              completed({ verification: 'pending' }),
              completed({ verification: 'unknown' }),
              completed({ currentness: 'requested_unknown' }),
              completed({ sha256: '../private' }),
              completed({ requestId: '/private/path' }),
              completed({ revision: 0 }),
            ],
          })
        ),
    });
    await flush();
    expect(h.bodies()).toHaveLength(0);
    expect(h.get('body-content').textContent).toBe('');
    expect(h.posts()).toHaveLength(0);
  });
});

describe('Read-only progress refresh (visibility and timer doubles)', () => {
  const progress = (status: string) =>
    snapshot({
      tasks: [
        {
          executionStatus: status,
          artifact: artifact({ verification: 'pending', currentness: 'requested_pending' }),
        },
      ],
    });

  it('polls visible queued/running work, deduplicates reads, then stops when completed', async () => {
    const next = deferred<ReturnType<typeof reply>>();
    let count = 0;
    const h = harness({ get: () => (++count === 1 ? reply(progress('queued')) : next.promise) });
    await flush();
    expect(h.reads()).toHaveLength(1);
    expect(h.get('refresh-mode').textContent).toContain('refresh_active');
    await h.advance(4999);
    expect(h.reads()).toHaveLength(1);
    await h.advance(1);
    expect(h.reads()).toHaveLength(2);
    h.get('refresh').fire();
    await h.advance(10000);
    expect(h.reads()).toHaveLength(2);
    next.resolve(
      reply(snapshot({ tasks: [{ executionStatus: 'work_completed', artifact: artifact() }] }))
    );
    await flush();
    await h.advance(120000);
    expect(h.reads()).toHaveLength(2);
    expect(h.get('refresh-mode').textContent).toContain('refresh_paused');
    expect(h.posts()).toHaveLength(0);
  });

  it.each([
    'awaiting_approval',
    'blocked',
    'cancel_requested',
    'uncertain',
    'failed',
    'released',
    'parked',
    'work_completed',
  ])('does not poll or auto-submit parked/terminal state %s', async (status) => {
    const h = harness({ get: () => reply(progress(status)) });
    await flush();
    await h.advance(120000);
    h.visibility(true);
    h.visibility(false);
    await flush();
    expect(h.reads()).toHaveLength(1);
    expect(h.posts()).toHaveLength(0);
    expect(h.timers.size).toBe(0);
  });

  it('pauses hidden and page-hidden work, resumes visible work, and rejects old snapshot responses', async () => {
    const stale = deferred<ReturnType<typeof reply>>();
    let count = 0;
    const h = harness({
      get: () =>
        ++count === 2 ? stale.promise : reply(progress(count === 3 ? 'running' : 'queued')),
    });
    await flush();
    h.visibility(true);
    await h.advance(60000);
    expect(h.reads()).toHaveLength(1);
    h.visibility(false);
    await flush();
    expect(h.reads()).toHaveLength(2);
    h.visibility(true);
    h.visibility(false);
    await flush();
    expect(h.reads()).toHaveLength(3);
    stale.resolve(reply(progress('blocked')));
    await flush();
    expect(h.get('history').textContent).toContain('status_running');
    expect(h.get('history').textContent).not.toContain('status_blocked');
    expect(h.timers.size).toBe(1);
    h.page('pagehide');
    await h.advance(60000);
    expect(h.reads()).toHaveLength(3);
    h.page('pageshow');
    await flush();
    expect(h.reads()).toHaveLength(4);
    expect(h.posts()).toHaveLength(0);
  });

  it('backs off failed reads, keeps last successful check visible, and recovers without a POST', async () => {
    let count = 0;
    const h = harness({
      get: () => {
        count++;
        if (count === 2) throw new Error('offline');
        if (count === 3) return reply({ ok: false }, 503);
        return reply(progress('running'));
      },
    });
    await flush();
    const checked = h.get('last-checked').textContent;
    await h.advance(5000);
    expect(h.reads()).toHaveLength(2);
    expect(h.get('refresh-error').hidden).toBe(false);
    expect(h.get('last-checked').textContent).toBe(checked);
    expect(h.get('refresh-mode').textContent).toContain('refresh_backoff');
    await h.advance(9999);
    expect(h.reads()).toHaveLength(2);
    await h.advance(1);
    expect(h.reads()).toHaveLength(3);
    await h.advance(19999);
    expect(h.reads()).toHaveLength(3);
    await h.advance(1);
    expect(h.reads()).toHaveLength(4);
    expect(h.get('refresh-error').hidden).toBe(true);
    await h.advance(5000);
    expect(h.reads()).toHaveLength(5);
    expect(h.posts()).toHaveLength(0);
  });

  it('clears stale body data and stops polling on loss of read authorization', async () => {
    let count = 0;
    const h = harness({
      get: () =>
        ++count === 1
          ? reply(
              snapshot({
                tasks: [
                  {
                    executionStatus: 'work_completed',
                    artifact: artifact({ currentness: 'older_verified' }),
                  },
                  {
                    executionStatus: 'running',
                    artifact: artifact({
                      requestId: second,
                      revision: 2,
                      verification: 'pending',
                      currentness: 'requested_pending',
                    }),
                  },
                ],
              })
            )
          : reply({ ok: false }, 403),
    });
    await flush();
    expect(h.get('body-content').textContent).not.toBe('');
    await h.advance(5000);
    await h.advance(120000);
    expect(h.reads()).toHaveLength(2);
    expect(h.get('body-content').textContent).toBe('');
    expect(h.get('start').disabled).toBe(true);
    expect(h.posts()).toHaveLength(0);
  });

  it('does not poll an approval-held request even if its execution status says queued', async () => {
    const h = harness({
      get: () => reply(progress('queued')),
      heldRequests: [
        {
          request_id: first,
          status: 'approval_verification_failed',
          recovery: 'operator_recovery',
        },
      ],
    });
    await flush();
    await h.advance(120000);
    expect(h.reads()).toHaveLength(1);
    expect(h.posts()).toHaveLength(0);
  });
});

describe('Receipt access invalidation and bounded-read recovery (DOM doubles)', () => {
  const key = (id: string, revision: number) => id + ':' + revision + ':' + sha256;
  const third = '33333333-3333-4333-8333-333333333333';
  const completed = (requestId: string, revision: number) => ({
    executionStatus: 'work_completed',
    artifact: artifact({
      requestId,
      revision,
      currentness: revision === 3 ? 'latest_verified' : 'older_verified',
    }),
  });
  const active = () =>
    snapshot({
      tasks: [
        {
          executionStatus: 'running',
          artifact: artifact({ verification: 'pending', currentness: 'requested_pending' }),
        },
      ],
    });

  it.each([401, 403])(
    'revokes cached and pending bodies together when a body GET returns %s',
    async (status) => {
      const pending = deferred<ReturnType<typeof reply>>();
      const h = harness({
        get: () =>
          reply(
            snapshot({ tasks: [completed(first, 1), completed(second, 2), completed(third, 3)] })
          ),
        body: (query) =>
          query.get('request_id') === third
            ? pending.promise
            : query.get('request_id') === second
              ? reply({ ok: false }, status)
              : reply({ ok: true, sessionId: session, artifact: artifact({ body: '"cached"' }) }),
      });
      await flush();
      expect(h.get('left-content').textContent).toBe('"cached"');
      h.get('body-select').value = key(second, 2);
      h.get('body-select').fire('change');
      await flush();
      pending.resolve(
        reply({
          ok: true,
          sessionId: session,
          artifact: artifact({ requestId: third, revision: 3, body: '"late body"' }),
        })
      );
      await flush();
      for (const slot of ['body', 'left', 'right'])
        expect(h.get(slot + '-content').textContent).toBe('');
      expect(h.get('body-status').textContent).toContain('body_forbidden');
      expect(h.get('body-retry').disabled).toBe(true);
      expect(h.get('start').disabled).toBe(true);
      expect(h.timers.size).toBe(0);
      expect(h.posts()).toHaveLength(0);
    }
  );

  it.each([401, 403, 409])(
    'invalidates old body authority after a mutation conflict/auth failure %s',
    async (status) => {
      const pending = deferred<ReturnType<typeof reply>>();
      const h = harness({
        get: () =>
          reply(
            snapshot({
              tasks: [
                completed(first, 1),
                {
                  executionStatus: 'work_completed',
                  artifact: artifact({ requestId: second, revision: 2 }),
                },
              ],
              messages: [
                {
                  role: 'secretary',
                  artifact: artifact({ requestId: second, revision: 2, canRevise: true }),
                },
              ],
            })
          ),
        body: (query) =>
          query.get('request_id') === first
            ? pending.promise
            : reply({
                ok: true,
                sessionId: session,
                artifact: artifact({ requestId: second, revision: 2, body: '"cached"' }),
              }),
        post: async () => reply({ ok: false, retry_safe: false }, status),
      });
      await flush();
      expect(h.get('body-content').textContent).toBe('"cached"');
      h.get('history')
        .descendants()
        .find((node) => node.tagName === 'button')!
        .fire();
      await flush();
      pending.resolve(
        reply({ ok: true, sessionId: session, artifact: artifact({ body: '"late"' }) })
      );
      await flush();
      for (const slot of ['body', 'left', 'right'])
        expect(h.get(slot + '-content').textContent).toBe('');
      expect(h.get('start').disabled).toBe(true);
      expect(h.posts()).toHaveLength(1);
      await h.advance(120000);
      expect(h.posts()).toHaveLength(1);
    }
  );

  it('bounds hung snapshot GETs, enters backoff, and ignores late completion after recovery', async () => {
    const stale = deferred<ReturnType<typeof reply>>();
    let count = 0;
    const h = harness({ get: () => (++count === 2 ? stale.promise : reply(active())) });
    await flush();
    await h.advance(5000);
    expect(h.reads()).toHaveLength(2);
    await h.advance(15000);
    expect(h.get('refresh').disabled).toBe(false);
    expect(h.get('refresh-mode').textContent).toContain('refresh_backoff');
    await h.advance(10000);
    expect(h.reads()).toHaveLength(3);
    expect(h.get('refresh-error').hidden).toBe(true);
    stale.resolve(reply(snapshot()));
    await flush();
    expect(h.get('history').textContent).toContain('status_running');
    expect(h.posts()).toHaveLength(0);
  });

  it('bounds hung body GETs and lets an explicit read retry recover without stale body replacement', async () => {
    const stale = deferred<ReturnType<typeof reply>>();
    let count = 0;
    const h = harness({
      get: () => reply(snapshot({ tasks: [completed(first, 1)] })),
      body: () =>
        ++count === 1
          ? stale.promise
          : reply({ ok: true, sessionId: session, artifact: artifact({ body: '"recovered"' }) }),
    });
    await flush();
    await h.advance(15000);
    expect(h.get('body-status').textContent).toContain('body_failed');
    expect(h.get('body-retry').disabled).toBe(false);
    h.get('body-retry').fire();
    await flush();
    expect(h.get('body-content').textContent).toBe('"recovered"');
    stale.resolve(reply({ ok: true, sessionId: session, artifact: artifact({ body: '"stale"' }) }));
    await flush();
    expect(h.get('body-content').textContent).toBe('"recovered"');
    expect(h.posts()).toHaveLength(0);
  });

  it('resumes a suspended initial read even before an active snapshot exists', async () => {
    const stale = deferred<ReturnType<typeof reply>>();
    let count = 0;
    const h = harness({ get: () => (++count === 1 ? stale.promise : reply(snapshot())) });
    await flush();
    h.visibility(true);
    h.visibility(false);
    await flush();
    expect(h.reads()).toHaveLength(2);
    expect(h.get('readiness').textContent).toContain('first_job_ready');
    stale.resolve(reply(active()));
    await flush();
    expect(h.get('history').textContent).toContain('first_job_empty');
    expect(h.timers.size).toBe(0);
    expect(h.posts()).toHaveLength(0);
  });

  it('resumes an interrupted manual read of terminal work after page restore', async () => {
    const stale = deferred<ReturnType<typeof reply>>();
    let count = 0;
    const h = harness({ get: () => (++count === 2 ? stale.promise : reply(snapshot())) });
    await flush();
    h.get('refresh').fire();
    await flush();
    h.page('pagehide');
    h.page('pageshow');
    await flush();
    expect(h.reads()).toHaveLength(3);
    expect(h.get('refresh').disabled).toBe(false);
    expect(h.posts()).toHaveLength(0);
  });

  it('keeps session-less unavailable mapping guidance truthful and clears receipt data', async () => {
    let changed = false;
    const h = harness({
      get: () =>
        reply(
          changed
            ? {
                ok: true,
                readiness: { ready: false, status: 'mapping_changed' },
                tasks: [],
                messages: [],
              }
            : snapshot({ tasks: [completed(first, 1)] })
        ),
    });
    await flush();
    expect(h.get('body-content').textContent).not.toBe('');
    changed = true;
    h.get('refresh').fire();
    await flush();
    expect(h.get('readiness').textContent).toContain('mapping_changed');
    expect(h.get('setup').hidden).toBe(false);
    expect(h.get('body-content').textContent).toBe('');
    expect(h.get('start').disabled).toBe(true);
    expect(h.get('refresh-error').hidden).toBe(true);
    expect(h.posts()).toHaveLength(0);
  });
});

describe('Progress and receipt freshness consistency', () => {
  it('does not restart polling after a held queued request has a failed manual refresh', async () => {
    let count = 0;
    const h = harness({
      heldRequests: [
        {
          request_id: first,
          status: 'approval_verification_failed',
          recovery: 'operator_recovery',
        },
      ],
      get: () => {
        if (++count > 1) throw new Error('offline');
        return reply(
          snapshot({
            tasks: [
              {
                executionStatus: 'queued',
                artifact: artifact({ verification: 'pending', currentness: 'requested_pending' }),
              },
            ],
          })
        );
      },
    });
    await flush();
    h.get('refresh').fire();
    await flush();
    await h.advance(120000);
    expect(h.reads()).toHaveLength(2);
    expect(h.timers.size).toBe(0);
    expect(h.posts()).toHaveLength(0);
  });

  it('honors newer older-version evidence from body reads and removes stale revision authority', async () => {
    const h = harness({
      get: () =>
        reply(
          snapshot({
            tasks: [{ executionStatus: 'work_completed', artifact: artifact() }],
            messages: [{ role: 'secretary', artifact: artifact({ canRevise: true }) }],
          })
        ),
      body: () =>
        reply({
          ok: true,
          sessionId: session,
          artifact: artifact({
            currentness: 'older_verified',
            verifiedAt: 1234567900000,
            body: '{}\n',
          }),
        }),
    });
    await flush();
    expect(h.get('body-content').textContent).toBe('{}\n');
    expect(h.get('body-metadata').textContent).toContain('first_job_older');
    expect(h.get('body-metadata').textContent).not.toContain('first_job_latest');
    expect(h.get('body-metadata').textContent).toContain('first_job_checked_at');
    expect(h.get('history').textContent).toContain('first_job_older');
    expect(
      h
        .get('history')
        .descendants()
        .filter((node) => node.tagName === 'button')
    ).toHaveLength(0);
    expect(h.posts()).toHaveLength(0);
  });
});

describe('Approval read coordination remains bounded', () => {
  it('bounds an inherited hanging approval read and retains held state through interim callbacks', async () => {
    const pending = deferred<void>();
    const h = harness({
      heldRequests: [
        {
          request_id: first,
          status: 'approval_verification_failed',
          recovery: 'operator_recovery',
        },
      ],
      get: () =>
        reply(
          snapshot({
            tasks: [
              {
                executionStatus: 'queued',
                artifact: artifact({
                  verification: 'pending',
                  currentness: 'requested_pending',
                }),
              },
            ],
          })
        ),
    });
    await flush();
    h.window.KyberionFirstJobApproval.check = async (context) => {
      context.onChange({ ready: false, busy: false });
      await pending.promise;
      context.onChange({ ready: true, busy: false });
    };
    h.get('refresh').fire();
    await flush();
    await h.advance(15000);
    expect(h.get('refresh').disabled).toBe(false);
    expect(h.get('history').textContent).toContain('approval_held');
    pending.resolve();
    await flush();
    await h.advance(120000);
    expect(h.reads()).toHaveLength(2);
    expect(h.timers.size).toBe(0);
    expect(h.posts()).toHaveLength(0);
  });
});

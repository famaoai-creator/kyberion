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
  fire() {
    this.listeners.click?.();
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
    get?: () => ReturnType<typeof reply>;
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
    ].map((id) => [id, new Element()])
  );
  elements.get('error')!.textContent = 'Server-rendered load failure';
  const storage = options.storage ?? new Map<string, string>();
  const window = {
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
    if (url.startsWith('/api/first-job?')) return options.get ? options.get() : reply(snapshot());
    throw new Error('Unexpected fetch ' + url);
  });
  const document = {
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
  return { get, window, storage, fetch, posts };
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

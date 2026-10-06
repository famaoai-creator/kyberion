import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { safeReadFile } from '@agent/core/secure-io';
import { readJson } from '@agent/core/foundation';

// Inert DOM/network fixtures only. This does not exercise a live sign-in or approve real work.
class Element {
  children: Element[] = [];
  private ownText = '';
  disabled = false;
  hidden = false;
  className = '';
  type = '';
  listeners: Record<string, () => void> = {};
  constructor(
    readonly tagName = 'div',
    private onFocus?: (element: Element) => void
  ) {}
  focus() {
    this.onFocus?.(this);
  }
  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join(' ');
  }
  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }
  set innerHTML(_value: string) {
    throw new Error('HTML injection is forbidden');
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
const approvalId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const displayDigest = 'd'.repeat(64);
const payloadHash = 'b'.repeat(64);
const binding = 'first-job:' + 'c'.repeat(64);
const now = new Date('2026-10-05T18:00:00Z');
const item = (overrides: Record<string, unknown> = {}) => ({
  approval_request_id: approvalId,
  request_id: requestId,
  revision: 2,
  expires_at: '2026-10-08T18:00:00Z',
  execution_deadline_at: '2026-10-05T19:00:00Z',
  display_digest: displayDigest,
  payload_hash: payloadHash,
  effect_binding: binding,
  artifact_path: '/private/never-render-me.json',
  receipt_format: 'pretty',
  tenant: 'test-tenant',
  ...overrides,
});
const view = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  auth: { status: 'ready', login_href: '/login?next=%2Ffirst-job' },
  readiness: { ready: true, status: 'ready' },
  approvals: [item()],
  ...overrides,
});
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(
  options: {
    get?: () => Promise<ReturnType<typeof response>> | ReturnType<typeof response>;
    post?: (body: Record<string, unknown>) => Promise<ReturnType<typeof response>>;
    snapshot?: Record<string, unknown>;
    signal?: AbortSignal;
  } = {}
) {
  const elements = new Map(
    ['readiness', 'signin', 'refresh', 'error', 'status', 'items'].map((id) => [id, new Element()])
  );
  const context = {
    signal: options.signal,
    snapshot: {
      sessionId: session,
      scope: { tenant: 'test-tenant', tier: 'public' },
      readiness: { ready: true, status: 'diagnostic_mapping_ready' },
      ...options.snapshot,
    },
    vocab: new Proxy({} as Record<string, string>, { get: (_target, key) => String(key) }),
    locale: 'en',
    onChange: vi.fn(),
    onDecision: vi.fn(),
  };
  const fetch = vi.fn(
    async (
      url: string,
      init?: {
        method?: string;
        body?: string;
        headers?: Record<string, string>;
        signal?: AbortSignal;
      }
    ) => {
      if (init?.method === 'POST')
        return options.post
          ? options.post(JSON.parse(init.body!))
          : response({
              ok: true,
              approval_request_id: approvalId,
              status: JSON.parse(init.body!).decision,
            });
      if (url.startsWith('/api/first-job/approvals?'))
        return options.get ? options.get() : response(view());
      throw new Error('Unexpected request: ' + url);
    }
  );
  const window = {
    AbortController,
    setTimeout: (handler: () => void, delay: number) => setTimeout(handler, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    KyberionFirstJobApproval: undefined as
      undefined | { check: (context: unknown) => Promise<void>; invalidate: () => void },
  };
  const document = {
    activeElement: null as Element | null,
    getElementById: (id: string) => elements.get(id.replace('first-job-approval-', '')) ?? null,
    createElement: (tag: string) =>
      new Element(tag, (element) => {
        document.activeElement = element;
      }),
  };
  runInNewContext(
    String(
      safeReadFile('presence/displays/presence-studio/static/first-job-approval.js', {
        encoding: 'utf8',
      })
    ),
    { window, document, fetch, URLSearchParams, Date }
  );
  window.KyberionFirstJobApproval!.check(context);
  const get = (id: string) => elements.get(id)!;
  return {
    context,
    fetch,
    window,
    document,
    get,
    posts: () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST'),
    buttons: () =>
      get('items')
        .descendants()
        .filter((node) => node.tagName === 'button'),
    refresh: () => window.KyberionFirstJobApproval!.check(context),
  };
}

beforeEach(() => vi.useFakeTimers({ now, toFake: ['Date', 'setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

describe('Dedicated diagnostic approval UI with inert fixtures', () => {
  it('reads on load only and passes no caller identity or tenant selection', async () => {
    const h = harness();
    await flush();
    expect(h.posts()).toHaveLength(0);
    expect(h.fetch.mock.calls[0][0]).toBe(
      '/api/first-job/approvals?session_id=' + session + '&locale=en'
    );
    expect(h.context.onChange).toHaveBeenLastCalledWith({ ready: true, busy: false });
    expect(h.get('readiness').textContent).toContain('approval_ready');
  });

  it.each([
    ['authentication_required', 'approval_auth_needed', false],
    ['authentication_configuration_required', 'approval_configuration', false],
    ['access_denied', 'approval_forbidden', true],
    ['loopback', 'approval_unknown', true],
  ])(
    'blocks pre-task eligibility and decisions for auth status %s',
    async (status, key, hideLogin) => {
      const h = harness({
        get: () =>
          response(
            view({
              auth: { status },
              readiness: { ready: false, status: 'authentication_required' },
            })
          ),
      });
      await flush();
      expect(h.context.onChange).toHaveBeenLastCalledWith({
        ready: false,
        busy: false,
        ...(status === 'loopback' ? {} : { accessLost: true }),
      });
      expect(h.get('readiness').textContent).toContain(key);
      expect(h.get('signin').hidden).toBe(hideLogin);
      expect(h.buttons()).toHaveLength(0);
      expect(h.posts()).toHaveLength(0);
    }
  );

  it('recognizes verified eligibility even before any diagnostic request exists', async () => {
    const h = harness({ get: () => response(view({ approvals: [] })) });
    await flush();
    expect(h.context.onChange).toHaveBeenLastCalledWith({ ready: true, busy: false });
    expect(h.get('status').textContent).toContain('approval_empty');
  });

  it('displays exact bounded effects and effective session deadline without raw filesystem paths', async () => {
    const h = harness();
    await flush();
    const content = h.get('items').textContent;
    for (const value of [
      approvalId,
      requestId,
      displayDigest,
      payloadHash,
      binding,
      'test-tenant',
      'approval_destination_local',
      'approval_effect',
      'approval_validity',
    ])
      expect(content).toContain(value);
    expect(content).toContain(new Date('2026-10-05T19:00:00Z').toLocaleString('en'));
    expect(content).not.toContain(new Date('2026-10-08T18:00:00Z').toLocaleString('en'));
    expect(content).not.toMatch(/private|never-render|artifact_path|undefined/);
  });

  it.each(['approved', 'rejected'])(
    'sends an exact digest-bound %s decision only on its explicit click',
    async (decision) => {
      const h = harness();
      await flush();
      h.buttons()[decision === 'approved' ? 0 : 1].fire();
      await flush();
      expect(h.posts()).toHaveLength(1);
      const [url, init] = h.posts()[0];
      expect(url).toBe('/api/first-job/approvals/' + approvalId + '/decision');
      expect(JSON.parse(init!.body!)).toEqual({
        decision,
        display_digest: displayDigest,
        session_id: session,
      });
      expect(init!.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(h.context.onDecision).toHaveBeenCalledOnce();
      expect(h.get('status').textContent).toContain('approval_recorded');
    }
  );

  it('suppresses duplicate clicks while sending and never races approve against reject', async () => {
    const pending = deferred<ReturnType<typeof response>>();
    const h = harness({ post: async () => pending.promise });
    await flush();
    const [approve, reject] = h.buttons();
    approve.fire();
    approve.fire();
    reject.fire();
    await flush();
    expect(h.posts()).toHaveLength(1);
    expect(h.context.onChange).toHaveBeenLastCalledWith({ ready: false, busy: true });
    pending.resolve(response({ ok: true, approval_request_id: approvalId, status: 'approved' }));
    await flush();
    expect(h.posts()).toHaveLength(1);
  });

  it('invalidates old displayed digests after refresh changes the request', async () => {
    let changed = false;
    const h = harness({
      get: () =>
        response(
          view({ approvals: [item({ display_digest: changed ? 'e'.repeat(64) : displayDigest })] })
        ),
    });
    await flush();
    const oldButton = h.buttons()[0];
    changed = true;
    await h.refresh();
    oldButton.fire();
    await flush();
    expect(h.posts()).toHaveLength(0);
    h.buttons()[0].fire();
    await flush();
    expect(JSON.parse(h.posts()[0][1]!.body!).display_digest).toBe('e'.repeat(64));
  });

  it('does not auto-replay an uncertain decision; a new view only reads', async () => {
    const h = harness({
      post: async () => {
        throw new Error('response lost');
      },
    });
    await flush();
    h.buttons()[0].fire();
    await flush();
    expect(h.get('error').textContent).toContain('approval_uncertain');
    expect(h.context.onDecision).not.toHaveBeenCalled();
    expect(h.buttons().every((button) => button.disabled)).toBe(true);
    expect(h.posts()).toHaveLength(1);
    const reloaded = harness();
    await flush();
    expect(reloaded.posts()).toHaveLength(0);
  });

  it('requires fresh review after stale-target rejection, without automatic retry', async () => {
    const h = harness({
      post: async () => response({ ok: false, error: 'stale_digest', retry_safe: true }, 409),
    });
    await flush();
    h.buttons()[0].fire();
    await flush();
    expect(h.get('error').textContent).toContain('approval_changed');
    expect(h.posts()).toHaveLength(1);
    expect(h.buttons().every((button) => button.disabled)).toBe(true);
  });

  it.each([
    { execution_deadline_at: undefined },
    { execution_deadline_at: '2026-10-05T17:59:59Z' },
    { execution_deadline_at: '2026-10-09T18:00:00Z' },
    { tenant: 'other-tenant' },
    { display_digest: '<script>bad</script>' },
    { effect_binding: 'arbitrary-effect' },
  ])('fails closed on malformed, out-of-scope, or expired approval data: %j', async (override) => {
    const h = harness({ get: () => response(view({ approvals: [item(override)] })) });
    await flush();
    expect(h.context.onChange).toHaveBeenLastCalledWith({ ready: false, busy: false });
    expect(h.buttons()).toHaveLength(0);
    expect(h.posts()).toHaveLength(0);
  });

  it('rechecks the effective deadline at click time', async () => {
    const h = harness();
    await flush();
    const button = h.buttons()[0];
    vi.setSystemTime(new Date('2026-10-05T19:00:01Z'));
    button.fire();
    await flush();
    expect(h.posts()).toHaveLength(0);
    expect(h.get('error').textContent).toContain('approval_changed');
    expect(h.context.onChange).toHaveBeenLastCalledWith({ ready: false, busy: false });
  });

  it('invalidates approval actions when the main diagnostic scope becomes unavailable', async () => {
    const h = harness();
    await flush();
    const oldButton = h.buttons()[0];
    h.window.KyberionFirstJobApproval!.invalidate();
    oldButton.fire();
    await flush();
    expect(h.posts()).toHaveLength(0);
    expect(h.buttons()).toHaveLength(0);
    expect(h.context.onChange).toHaveBeenLastCalledWith({ ready: false, busy: false });
  });

  it('discards late reads from an older scope view', async () => {
    const delayed = deferred<ReturnType<typeof response>>();
    let firstRead = true;
    const h = harness({
      get: () => {
        if (firstRead) {
          firstRead = false;
          return delayed.promise;
        }
        return response(
          view({
            auth: { status: 'access_denied' },
            readiness: { ready: false, status: 'authentication_required' },
          })
        );
      },
    });
    await h.refresh();
    delayed.resolve(response(view()));
    await flush();
    expect(h.get('readiness').textContent).toContain('approval_forbidden');
    expect(h.buttons()).toHaveLength(0);
  });

  it('uses only the existing fixed sign-in route and never copies a login URL from server data', () => {
    const html = String(
      safeReadFile('presence/displays/presence-studio/static/first-job.html', { encoding: 'utf8' })
    );
    const js = String(
      safeReadFile('presence/displays/presence-studio/static/first-job-approval.js', {
        encoding: 'utf8',
      })
    );
    expect(html).toContain('href="/login?next=%2Ffirst-job"');
    expect(js).not.toContain('login_href');
    expect(js).not.toMatch(/document\.cookie|Authorization|localStorage/);
  });

  it('states that sign-out alone does not revoke approval while preserving expiry and invalidation guidance', () => {
    const catalog = readJson<{ domains: { front_desk: Record<string, Record<string, string>> } }>(
      'knowledge/product/orchestration/user-facing-vocabulary.json'
    );
    const copy = catalog.domains.front_desk.first_job_approval_validity;
    expect(copy.en).toContain('Signing out does not by itself revoke a recorded approval.');
    expect(copy.ja).toContain('サインアウトするだけでは、記録済みの承認は取り消されません。');
    expect(copy.en).toContain('Session-key changes, revoked membership, or a changed request');
    const script = String(
      safeReadFile('presence/displays/presence-studio/static/first-job-approval.js', {
        encoding: 'utf8',
      })
    );
    expect(script).toContain("text('approval_validity')");
    expect(script).toContain("'approval_execution_deadline'");
  });

  it('shows an owned held request as unverified and requiring operator recovery without an action', async () => {
    const held = {
      request_id: requestId,
      status: 'approval_verification_failed',
      recovery: 'operator_recovery',
    };
    const h = harness({ get: () => response(view({ approvals: [], held_requests: [held] })) });
    await flush();
    expect(h.get('status').textContent).toContain('approval_held');
    expect(h.get('items').textContent).toContain(requestId);
    expect(h.get('items').textContent).toContain('approval_held_detail');
    expect(h.buttons()).toHaveLength(0);
    expect(h.posts()).toHaveLength(0);
    expect(h.context.onChange).toHaveBeenLastCalledWith({
      ready: true,
      busy: false,
      heldRequests: [held],
    });
    h.window.KyberionFirstJobApproval!.invalidate();
    expect(h.get('items').textContent).not.toContain(requestId);
    expect(h.context.onChange).toHaveBeenLastCalledWith({ ready: false, busy: false });
  });

  it('fails closed on conflicting actionable and held entries', async () => {
    const h = harness({
      get: () =>
        response(
          view({
            held_requests: [
              {
                request_id: requestId,
                status: 'approval_verification_failed',
                recovery: 'operator_recovery',
              },
            ],
          })
        ),
    });
    await flush();
    expect(h.buttons()).toHaveLength(0);
    expect(h.context.onChange).toHaveBeenLastCalledWith({ ready: false, busy: false });
    expect(h.posts()).toHaveLength(0);
  });
});

describe('Read-only approval fetch timeout and cancellation', () => {
  it('aborts a hung GET at the read deadline and keeps explicit decision POST behavior untouched', async () => {
    const pending = deferred<ReturnType<typeof response>>();
    let firstRead = true;
    const h = harness({
      get: () => (firstRead ? ((firstRead = false), pending.promise) : response(view())),
    });
    await flush();
    const signal = h.fetch.mock.calls[0][1]!.signal!;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(15000);
    await flush();
    expect(signal.aborted).toBe(true);
    expect(h.get('refresh').disabled).toBe(false);
    expect(h.get('error').textContent).toContain('approval_failed');
    expect(h.buttons()).toHaveLength(0);
    expect(h.posts()).toHaveLength(0);
    await h.refresh();
    pending.resolve(response(view({ approvals: [item({ display_digest: 'e'.repeat(64) })] })));
    await flush();
    h.buttons()[0].fire();
    await flush();
    expect(h.posts()).toHaveLength(1);
    expect(h.posts()[0][1]!.signal).toBeUndefined();
    expect(JSON.parse(h.posts()[0][1]!.body!).display_digest).toBe(displayDigest);
  });

  it.each(['parent', 'invalidate', 'replace'])(
    'cancels the old GET on %s and ignores its late approval data',
    async (kind) => {
      const pending = deferred<ReturnType<typeof response>>();
      const controller = new AbortController();
      let firstRead = true;
      const h = harness({
        signal: controller.signal,
        get: () =>
          firstRead ? ((firstRead = false), pending.promise) : response(view({ approvals: [] })),
      });
      await flush();
      const signal = h.fetch.mock.calls[0][1]!.signal!;
      if (kind === 'parent') controller.abort();
      else if (kind === 'invalidate') h.window.KyberionFirstJobApproval!.invalidate();
      else await h.refresh();
      await flush();
      expect(signal.aborted).toBe(true);
      pending.resolve(response(view()));
      await flush();
      expect(h.buttons()).toHaveLength(0);
      expect(h.posts()).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});

describe('Explicit parked-request recovery with inert fixtures', () => {
  const recovery = (overrides: Record<string, unknown> = {}) => ({
    request_id: requestId,
    approval_request_id: approvalId,
    session_id: session,
    status: 'eligible',
    display_digest: displayDigest,
    revision: 2,
    tenant: 'test-tenant',
    ...overrides,
  });
  const recoveryView = (overrides: Record<string, unknown> = {}) =>
    view({ approvals: [], recovery_requests: [recovery()], ...overrides });
  const terminalResponse = () =>
    response({ ok: true, request_id: requestId, status: 'terminated_unstarted' });
  it('requires a separate review and confirm, retains old identities in the display, and sends only the terminal command', async () => {
    const h = harness({
      get: () => response(recoveryView()),
      post: async () => terminalResponse(),
    });
    await flush();
    expect(h.posts()).toHaveLength(0);
    expect(h.get('items').textContent).toContain('recovery_effect');
    expect(h.get('items').textContent).toContain(requestId);
    expect(h.get('items').textContent).toContain(approvalId);
    h.buttons()[0].fire();
    await flush();
    expect(h.posts()).toHaveLength(0);
    expect(h.get('items').textContent).toContain('recovery_confirm_detail');
    const confirm = h.buttons()[0];
    confirm.fire();
    confirm.fire();
    await flush();
    expect(h.posts()).toHaveLength(1);
    expect(h.posts()[0][0]).toBe('/api/first-job/recovery/' + requestId);
    expect(JSON.parse(h.posts()[0][1]!.body!)).toEqual({
      session_id: session,
      display_digest: displayDigest,
      action: 'terminate_unstarted',
    });
    expect(h.context.onDecision).toHaveBeenCalledOnce();
    expect(h.context.onChange).toHaveBeenLastCalledWith({ ready: false, busy: false });
    expect(h.get('status').textContent).toContain('recovery_readback');
    expect(h.get('items').textContent).not.toContain('recovery_terminated');
  });
  it('cancels without effects and never lets an old confirm button bypass a fresh review', async () => {
    const h = harness({ get: () => response(recoveryView()) });
    await flush();
    h.buttons()[0].fire();
    const [oldConfirm, cancel] = h.buttons();
    cancel.fire();
    oldConfirm.fire();
    await flush();
    expect(h.posts()).toHaveLength(0);
    h.buttons()[0].fire();
    expect(h.posts()).toHaveLength(0);
  });
  it('keeps keyboard focus on the replacement action when reviewing and cancelling recovery', async () => {
    const h = harness({ get: () => response(recoveryView()) });
    await flush();
    h.buttons()[0].focus();
    h.buttons()[0].fire();
    expect(h.document.activeElement).toBe(h.buttons()[0]);
    expect(h.document.activeElement!.textContent).toContain('recovery_confirm');
    h.buttons()[1].focus();
    h.buttons()[1].fire();
    expect(h.document.activeElement).toBe(h.buttons()[0]);
    expect(h.document.activeElement!.textContent).toContain('recovery_review');
    expect(h.posts()).toHaveLength(0);
  });
  it('resets confirmation after a changed digest and rejects the prior displayed action', async () => {
    let changed = false;
    const h = harness({
      get: () =>
        response(
          recoveryView({
            recovery_requests: [
              recovery({ display_digest: changed ? 'e'.repeat(64) : displayDigest }),
            ],
          })
        ),
      post: async () => terminalResponse(),
    });
    await flush();
    h.buttons()[0].fire();
    const old = h.buttons()[0];
    changed = true;
    await h.refresh();
    old.fire();
    expect(h.posts()).toHaveLength(0);
    h.buttons()[0].fire();
    h.buttons()[0].fire();
    await flush();
    expect(JSON.parse(h.posts()[0][1]!.body!).display_digest).toBe('e'.repeat(64));
  });
  it('shows lost response as unknown and refreshes only with GET before exposing terminal proof', async () => {
    let ended = false;
    const h = harness({
      get: () =>
        response(
          recoveryView({
            recovery_requests: [recovery({ status: ended ? 'terminated_unstarted' : 'eligible' })],
          })
        ),
      post: async () => {
        ended = true;
        throw new Error('lost');
      },
    });
    await flush();
    h.buttons()[0].fire();
    h.buttons()[0].fire();
    await flush();
    expect(h.get('error').textContent).toContain('recovery_uncertain');
    expect(h.context.onDecision).not.toHaveBeenCalled();
    expect(h.buttons().every((button) => button.disabled)).toBe(true);
    await h.refresh();
    expect(h.posts()).toHaveLength(1);
    expect(h.buttons()).toHaveLength(0);
    expect(h.get('items').textContent).toContain('recovery_terminated');
    expect(h.context.onChange).toHaveBeenLastCalledWith({
      ready: true,
      busy: false,
      recoveryRequests: [recovery({ status: 'terminated_unstarted' })],
    });
  });
  it('times out without replaying and ignores a late terminal POST response', async () => {
    const pending = deferred<ReturnType<typeof response>>();
    const h = harness({ get: () => response(recoveryView()), post: async () => pending.promise });
    await flush();
    h.buttons()[0].fire();
    h.buttons()[0].fire();
    await vi.advanceTimersByTimeAsync(15000);
    await flush();
    expect(h.get('error').textContent).toContain('recovery_uncertain');
    pending.resolve(terminalResponse());
    await flush();
    expect(h.context.onDecision).not.toHaveBeenCalled();
    expect(h.posts()).toHaveLength(1);
  });
  it('ignores an in-flight terminal response after invalidation and a new unauthenticated view', async () => {
    const pending = deferred<ReturnType<typeof response>>();
    let signedOut = false;
    const h = harness({
      get: () =>
        response(
          signedOut
            ? recoveryView({
                auth: { status: 'authentication_required' },
                readiness: { ready: false, status: 'authentication_required' },
              })
            : recoveryView()
        ),
      post: async () => pending.promise,
    });
    await flush();
    h.buttons()[0].fire();
    h.buttons()[0].fire();
    h.window.KyberionFirstJobApproval!.invalidate();
    signedOut = true;
    await h.refresh();
    pending.resolve(terminalResponse());
    await flush();
    expect(h.context.onDecision).not.toHaveBeenCalled();
    expect(h.context.onChange).toHaveBeenLastCalledWith({
      ready: false,
      busy: false,
      accessLost: true,
    });
    expect(h.get('items').textContent).not.toContain(requestId);
  });
  it.each([
    { session_id: 'concierge-' + 'b'.repeat(64) },
    { tenant: 'other' },
    { revision: 0 },
    { approval_request_id: 'bad' },
    { display_digest: 'bad' },
    { status: 'incomplete' },
  ])('offers no action for malformed or mismatched recovery evidence: %j', async (override) => {
    const h = harness({
      get: () => response(recoveryView({ recovery_requests: [recovery(override)] })),
    });
    await flush();
    expect(h.buttons()).toHaveLength(0);
    expect(h.posts()).toHaveLength(0);
    expect(h.context.onChange).toHaveBeenLastCalledWith({ ready: false, busy: false });
  });
  it('clears recovery identities and reports authentication loss if the terminal POST is rejected', async () => {
    const h = harness({
      get: () => response(recoveryView()),
      post: async () => response({ ok: false, retry_safe: true }, 401),
    });
    await flush();
    h.buttons()[0].fire();
    h.buttons()[0].fire();
    await flush();
    expect(h.get('items').textContent).not.toContain(requestId);
    expect(h.context.onChange).toHaveBeenLastCalledWith({
      ready: false,
      busy: false,
      accessLost: true,
    });
    expect(h.get('signin').hidden).toBe(false);
    expect(h.context.onDecision).not.toHaveBeenCalled();
    expect(h.posts()).toHaveLength(1);
  });
  it.each([401, 403])(
    'clears recovery and parent snapshot after a malformed GET body with HTTP %s',
    async (status) => {
      let accessLost = false;
      const h = harness({
        get: () =>
          accessLost
            ? {
                ...response(null, status),
                json: async () => {
                  throw new SyntaxError('Invalid JSON');
                },
              }
            : response(recoveryView()),
      });
      await flush();
      expect(h.context.onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ recoveryRequests: [recovery()] })
      );
      accessLost = true;
      await h.refresh();
      expect(h.get('items').textContent).not.toContain(requestId);
      expect(h.buttons()).toHaveLength(0);
      expect(h.context.onChange).toHaveBeenLastCalledWith({
        ready: false,
        busy: false,
        accessLost: true,
      });
      expect(h.get('readiness').textContent).toContain(
        status === 401 ? 'approval_auth_needed' : 'approval_forbidden'
      );
    }
  );
  it.each([401, 403])(
    'clears recovery and parent snapshot after a malformed POST body with HTTP %s',
    async (status) => {
      const h = harness({
        get: () => response(recoveryView()),
        post: async () => ({
          ...response(null, status),
          json: async () => {
            throw new SyntaxError('Invalid JSON');
          },
        }),
      });
      await flush();
      h.buttons()[0].fire();
      h.buttons()[0].fire();
      await flush();
      expect(h.get('items').textContent).not.toContain(requestId);
      expect(h.buttons()).toHaveLength(0);
      expect(h.context.onChange).toHaveBeenLastCalledWith({
        ready: false,
        busy: false,
        accessLost: true,
      });
      expect(h.get('readiness').textContent).toContain(
        status === 401 ? 'approval_auth_needed' : 'approval_forbidden'
      );
      expect(h.context.onDecision).not.toHaveBeenCalled();
      expect(h.posts()).toHaveLength(1);
    }
  );
  it('rejects duplicate or conflicting recovery entries', async () => {
    for (const extra of [
      { recovery_requests: [recovery(), recovery()] },
      { approvals: [item()] },
      {
        held_requests: [
          {
            request_id: requestId,
            status: 'approval_verification_failed',
            recovery: 'operator_recovery',
          },
        ],
      },
    ]) {
      const h = harness({ get: () => response(recoveryView(extra)) });
      await flush();
      expect(h.buttons()).toHaveLength(0);
      expect(h.posts()).toHaveLength(0);
    }
  });
});

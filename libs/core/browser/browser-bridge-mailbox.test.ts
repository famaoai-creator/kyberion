import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { withLockSync } from '../foundation/lock-utils.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import {
  BROWSER_BRIDGE_MAILBOX_ROOT,
  BROWSER_BRIDGE_MAX_RESPONSE_BYTES,
  BROWSER_BRIDGE_OBSERVE_PROCEDURE_ID,
  BrowserBridgeMailboxError,
  awaitBrowserBridgeResponse,
  enqueueBrowserBridgeRequest,
  listDeliverableBrowserBridgeRequests,
  listPendingApprovalsForBridge,
  loadBrowserBridgeRequest,
  respondBrowserBridgeRequest,
  toBrowserBridgeRequestView,
  validateBrowserBridgeRequest,
  type BrowserBridgeRequest,
  type EnqueueBrowserBridgeRequestInput,
} from './browser-bridge-mailbox.js';

// Pass-through spy: lets the poll test prove terminal records skip the lock.
vi.mock('../foundation/lock-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../foundation/lock-utils.js')>();
  return { ...actual, withLockSync: vi.fn(actual.withLockSync) };
});

const ROOT = pathResolver.rootResolve(BROWSER_BRIDGE_MAILBOX_ROOT);
const T0 = new Date('2026-10-31T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const allowTenant = () => undefined;

afterEach(() => {
  safeRmSync(ROOT, { recursive: true, force: true });
});

function observe(overrides: Partial<EnqueueBrowserBridgeRequestInput> = {}) {
  return enqueueBrowserBridgeRequest(
    {
      request_kind: 'observe_tab',
      payload: {
        purpose: 'Read the order table',
        mode: 'text',
        allowed_origins: ['https://example.com'],
      },
      requested_by: { actor_id: 'agent:test', mission_id: 'MSN-TEST-1' },
      scope: { tier: 'personal' },
      ...overrides,
    },
    { now: T0, assertTenant: allowTenant }
  );
}

function localInfer() {
  return enqueueBrowserBridgeRequest(
    {
      request_kind: 'local_infer',
      payload: { task: 'summarize', input: 'Contact me at alice@example.com about the plan.' },
      requested_by: { actor_id: 'agent:test' },
      scope: { tier: 'personal' },
    },
    { now: T0 }
  );
}

function observation(request: BrowserBridgeRequest, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'browser-observation.v1',
    observation_id: 'OBS-1',
    procedure_id: BROWSER_BRIDGE_OBSERVE_PROCEDURE_ID,
    recording_id: request.request_id,
    lease_id: `LEASE-${request.request_id}`,
    origin: 'https://example.com',
    captured_at: '2026-10-31T00:01:00.000Z',
    source: 'chrome-extension',
    fields: [{ name: 'page', text: 'Call 090-1234-5678 or mail bob@example.com' }],
    ...overrides,
  };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof BrowserBridgeMailboxError ? err.code : `other:${String(err)}`;
  }
  return undefined;
}

describe('enqueueBrowserBridgeRequest', () => {
  it('stores a pending request under the tier/shared partition with the default TTL', () => {
    const request = observe();
    expect(request.request_id).toMatch(/^BBR-[0-9a-f-]{36}$/);
    expect(request.status).toBe('pending');
    expect(request.expires_at).toBe(at(10 * 60_000).toISOString());
    const file = path.join(ROOT, 'personal', 'shared', `${request.request_id}.json`);
    expect(safeExistsSync(file)).toBe(true);
    expect(JSON.parse(String(safeReadFile(file, { encoding: 'utf8' }))).request_id).toBe(
      request.request_id
    );
  });

  it('places confidential requests in the tenant partition and requires a tenant', () => {
    expect(code(() => observe({ scope: { tier: 'confidential' } }))).toBe('invalid_input');
    const request = observe({ scope: { tier: 'confidential', tenant_slug: 'acme' } });
    expect(
      safeExistsSync(path.join(ROOT, 'confidential', 'acme', `${request.request_id}.json`))
    ).toBe(true);
  });

  it('never accepts a reserved scope name or an unregistered tenant', () => {
    expect(code(() => observe({ scope: { tier: 'confidential', tenant_slug: 'shared' } }))).toBe(
      'invalid_input'
    );
    expect(code(() => observe({ scope: { tier: 'confidential', tenant_slug: 'public' } }))).toBe(
      'invalid_input'
    );
    // Default check goes through the tenant registry; no profile exists for this slug.
    expect(
      code(() =>
        enqueueBrowserBridgeRequest(
          {
            request_kind: 'notify',
            payload: { level: 'info', title: 't', body: 'b' },
            requested_by: { actor_id: 'agent:test' },
            scope: { tier: 'confidential', tenant_slug: 'no-such-tenant-zz' },
          },
          { now: T0 }
        )
      )
    ).toBe('invalid_input');
  });

  it('rejects a TTL above 60 minutes and schema violations', () => {
    expect(code(() => observe({ ttl_ms: 61 * 60_000 }))).toBe('invalid_input');
    expect(
      code(() => observe({ payload: { purpose: 'x'.repeat(301), mode: 'text' } as never }))
    ).toBe('invalid_input');
    expect(
      code(() =>
        observe({
          payload: { purpose: 'p', mode: 'text', allowed_origins: ['https://example.com/path'] },
        })
      )
    ).toBe('invalid_input');
  });

  it('keeps notify free of page data and redacts its free text', () => {
    expect(
      code(() =>
        enqueueBrowserBridgeRequest(
          {
            request_kind: 'notify',
            payload: { level: 'info', title: 't', body: 'b', page_text: 'secret' } as never,
            requested_by: { actor_id: 'agent:test' },
            scope: { tier: 'personal' },
          },
          { now: T0 }
        )
      )
    ).toBe('invalid_input');
    expect(
      code(() =>
        enqueueBrowserBridgeRequest(
          {
            request_kind: 'notify',
            payload: { level: 'approval_pending', title: 't', body: 'b' },
            requested_by: { actor_id: 'agent:test' },
            scope: { tier: 'personal' },
          },
          { now: T0 }
        )
      )
    ).toBe('invalid_input');
    const note = enqueueBrowserBridgeRequest(
      {
        request_kind: 'notify',
        payload: {
          level: 'progress',
          title: 'Build',
          body: 'ping ops@example.com',
          progress: { done: 1, total: 3 },
        },
        requested_by: { actor_id: 'agent:test' },
        scope: { tier: 'public' },
      },
      { now: T0 }
    );
    expect((note.payload as { body: string }).body).toBe('ping [redacted-email]');
  });

  it('redacts local_infer input before it is stored', () => {
    const request = localInfer();
    expect((request.payload as { input: string }).input).toContain('[redacted-email]');
  });
});

describe('review regressions: enqueue', () => {
  it('requires non-empty allowed_origins for a tenant-scoped observe_tab on every tier', () => {
    const confidential = { tier: 'confidential' as const, tenant_slug: 'acme' };
    let message = '';
    try {
      observe({ scope: confidential, payload: { purpose: 'Read it', mode: 'text' } });
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toMatch(/tenant-scoped \(scope.tenant_slug\) observe_tab request requires/);
    expect(
      code(() =>
        observe({
          scope: confidential,
          payload: { purpose: 'Read it', mode: 'text', allowed_origins: [] },
        })
      )
    ).toBe('invalid_input');
    // Personal scope keeps the optional allowlist.
    expect(observe({ payload: { purpose: 'Read it', mode: 'text' } }).status).toBe('pending');
    // ...but a tenant partition is tenant-scoped on every tier (personal/<tenant>, public/<tenant>).
    for (const tier of ['personal', 'public'] as const) {
      expect(
        code(() =>
          observe({
            scope: { tier, tenant_slug: 'acme' },
            payload: { purpose: 'Read it', mode: 'text' },
          })
        )
      ).toBe('invalid_input');
      expect(observe({ scope: { tier, tenant_slug: 'acme' } }).scope).toEqual({
        tier,
        tenant_slug: 'acme',
      });
    }
    const personalTenant = observe({ scope: { tier: 'personal', tenant_slug: 'acme' } });
    expect(
      validateBrowserBridgeRequest({
        ...personalTenant,
        payload: { purpose: 'Read it', mode: 'text' },
      }).valid
    ).toBe(false);
    // A stored confidential record without origins fails the schema too (fail closed).
    const stored = observe({ scope: confidential });
    const stripped = {
      ...stored,
      payload: { purpose: 'Read it', mode: 'text' },
    };
    expect(validateBrowserBridgeRequest(stripped).valid).toBe(false);
    safeWriteFile(
      path.join(ROOT, 'confidential', 'acme', `${stored.request_id}.json`),
      JSON.stringify(stripped)
    );
    expect(loadBrowserBridgeRequest(stored.request_id, { now: T0 })).toBeNull();
  });

  it('accepts valid input that redaction would push over maxLength, clamped after redaction', () => {
    // 6-char email -> 16-char token: 118 + 10 = 128 > 120 before the fix.
    const title = `${'t'.repeat(112)} a@b.co`;
    expect(title.length).toBe(119);
    const body = `${'b'.repeat(993)} a@b.co`;
    const notify = enqueueBrowserBridgeRequest(
      {
        request_kind: 'notify',
        payload: { level: 'info', title, body },
        requested_by: { actor_id: 'agent:test' },
        scope: { tier: 'personal' },
      },
      { now: T0 }
    );
    const payload = notify.payload as { title: string; body: string };
    expect(payload.title.length).toBe(120);
    expect(payload.body.length).toBe(1000);
    expect(payload.title).not.toContain('a@b.co');
    const purpose = `${'p'.repeat(293)} a@b.co`;
    expect(
      (observe({ payload: { purpose, mode: 'text' } }).payload as { purpose: string }).purpose
    ).toHaveLength(300);
    const input = `${'i'.repeat(29_993)} a@b.co`;
    const infer = enqueueBrowserBridgeRequest(
      {
        request_kind: 'local_infer',
        payload: { task: 'summarize', input },
        requested_by: { actor_id: 'agent:test' },
        scope: { tier: 'personal' },
      },
      { now: T0 }
    );
    expect((infer.payload as { input: string }).input).toHaveLength(30_000);
    // Raw input over the limit is still rejected (lengths are checked before redaction).
    expect(
      code(() => observe({ payload: { purpose: 'x'.repeat(301), mode: 'text' } as never }))
    ).toBe('invalid_input');
  });
});

describe('listDeliverableBrowserBridgeRequests', () => {
  it('marks pending requests delivered and sweeps expired ones', () => {
    const fresh = observe();
    const stale = observe({ ttl_ms: 60_000 });
    const listed = listDeliverableBrowserBridgeRequests({ now: at(2 * 60_000) });
    expect(listed.map((r) => r.request_id)).toEqual([fresh.request_id]);
    expect(listed[0].status).toBe('delivered');
    expect(loadBrowserBridgeRequest(fresh.request_id, { now: at(2 * 60_000) })?.status).toBe(
      'delivered'
    );
    expect(loadBrowserBridgeRequest(stale.request_id, { now: at(2 * 60_000) })?.status).toBe(
      'expired'
    );
    // Delivered requests stay visible until answered.
    expect(listDeliverableBrowserBridgeRequests({ now: at(3 * 60_000) })).toHaveLength(1);
    const view = toBrowserBridgeRequestView(listed[0]);
    expect(view).not.toHaveProperty('response');
    expect(view).not.toHaveProperty('delivered_at');
  });
});

describe('review regressions: poll cost', () => {
  it('skips terminal records without taking their lock, and still sweeps expiry', () => {
    const done = observe();
    respondBrowserBridgeRequest(done.request_id, { status: 'declined' }, { now: at(1000) });
    const stale = observe({ ttl_ms: 60_000 });
    const live = observe();
    const lock = vi.mocked(withLockSync);
    lock.mockClear();
    const listed = listDeliverableBrowserBridgeRequests({ now: at(2 * 60_000) });
    expect(listed.map((r) => r.request_id)).toEqual([live.request_id]);
    const lockedIds = lock.mock.calls.map(([id]) => id);
    expect(lockedIds).not.toContain(`browser-bridge-mailbox-${done.request_id}`);
    expect(lockedIds).toContain(`browser-bridge-mailbox-${stale.request_id}`);
    expect(loadBrowserBridgeRequest(stale.request_id, { now: at(2 * 60_000) })?.status).toBe(
      'expired'
    );
    // Once expired, the swept record is skipped cheaply on the next poll too.
    lock.mockClear();
    listDeliverableBrowserBridgeRequests({ now: at(3 * 60_000) });
    expect(lock.mock.calls.map(([id]) => id)).toEqual([
      `browser-bridge-mailbox-${live.request_id}`,
    ]);
  });
});

describe('respondBrowserBridgeRequest', () => {
  it('re-validates and re-redacts an observe_tab observation', () => {
    const request = observe();
    const updated = respondBrowserBridgeRequest(
      request.request_id,
      {
        status: 'completed',
        result: {
          observation: observation(request),
          webmcp_tools: [{ name: 'search', description: 'mail x@example.com', input_keys: ['q'] }],
        },
      },
      { now: at(60_000) }
    );
    expect(updated.status).toBe('completed');
    expect(updated.response?.origin).toBe('https://example.com');
    const text = JSON.stringify(updated.response?.result);
    expect(text).not.toContain('bob@example.com');
    expect(text).not.toContain('090-1234-5678');
    expect(text).toContain('[redacted-email]');
    expect(text).toContain('[redacted-phone]');
    expect(text).not.toContain('x@example.com');
  });

  it('rejects observations that fail the schema, are unbound, or come from another origin', () => {
    const request = observe();
    const respond = (obs: Record<string, unknown>) =>
      code(() =>
        respondBrowserBridgeRequest(
          request.request_id,
          { status: 'completed', result: { observation: obs } },
          { now: at(60_000) }
        )
      );
    expect(respond(observation(request, { fields: [] }))).toBe('invalid_response');
    expect(respond(observation(request, { recording_id: 'REC-other' }))).toBe('invalid_response');
    expect(respond(observation(request, { origin: 'https://evil.example' }))).toBe(
      'invalid_response'
    );
    expect(loadBrowserBridgeRequest(request.request_id, { now: at(60_000) })?.status).toBe(
      'pending'
    );
  });

  it('requires executable:false on local_infer results', () => {
    const request = localInfer();
    expect(
      code(() =>
        respondBrowserBridgeRequest(
          request.request_id,
          {
            status: 'completed',
            result: { provider: 'chrome-summarizer', task: 'summarize', output: 'ok' },
          },
          { now: at(1000) }
        )
      )
    ).toBe('invalid_response');
    const done = respondBrowserBridgeRequest(
      request.request_id,
      {
        status: 'completed',
        result: {
          provider: 'chrome-summarizer',
          task: 'summarize',
          output: 'Summary for carol@example.com',
          executable: false,
        },
      },
      { now: at(1000) }
    );
    expect(done.response?.result).toEqual({
      provider: 'chrome-summarizer',
      task: 'summarize',
      output: 'Summary for [redacted-email]',
      truncated: false,
      executable: false,
    });
  });

  it('redacts object keys in a local_infer output, suffixing collisions deterministically', () => {
    const request = localInfer();
    const done = respondBrowserBridgeRequest(
      request.request_id,
      {
        status: 'completed',
        result: {
          provider: 'chrome-prompt',
          task: 'summarize',
          output: {
            'alice@example.com': 'owner',
            'bob@example.com': { 'carol@example.com': 'nested' },
            plain: 'dave@example.com',
          },
          executable: false,
        },
      },
      { now: at(1000) }
    );
    const output = (done.response?.result as { output: Record<string, unknown> }).output;
    expect(Object.keys(output)).toEqual(['[redacted-email]', '[redacted-email] (2)', 'plain']);
    expect(output['[redacted-email] (2)']).toEqual({ '[redacted-email]': 'nested' });
    expect(output.plain).toBe('[redacted-email]');
    expect(JSON.stringify(done.response)).not.toMatch(/@example\.com/);
  });

  it('caps the response size at 64 KiB', () => {
    const request = localInfer();
    expect(
      code(() =>
        respondBrowserBridgeRequest(
          request.request_id,
          {
            status: 'completed',
            result: {
              provider: 'p',
              task: 'summarize',
              output: 'x'.repeat(BROWSER_BRIDGE_MAX_RESPONSE_BYTES),
              executable: false,
            },
          },
          { now: at(1000) }
        )
      )
    ).toBe('too_large');
  });

  it('rejects unknown, expired and already-terminal requests', () => {
    expect(
      code(() =>
        respondBrowserBridgeRequest('BBR-00000000-0000-4000-8000-000000000000', {
          status: 'declined',
        })
      )
    ).toBe('not_found');
    const request = observe();
    const declined = respondBrowserBridgeRequest(
      request.request_id,
      { status: 'declined', error: 'user said no' },
      { now: at(1000) }
    );
    expect(declined.status).toBe('declined');
    expect(
      code(() =>
        respondBrowserBridgeRequest(request.request_id, { status: 'failed' }, { now: at(2000) })
      )
    ).toBe('terminal');
    const late = observe();
    expect(
      code(() =>
        respondBrowserBridgeRequest(
          late.request_id,
          { status: 'declined' },
          { now: at(11 * 60_000) }
        )
      )
    ).toBe('expired');
    expect(loadBrowserBridgeRequest(late.request_id, { now: at(11 * 60_000) })?.status).toBe(
      'expired'
    );
  });

  it('accepts a notify acknowledgement without a result', () => {
    const note = enqueueBrowserBridgeRequest(
      {
        request_kind: 'notify',
        payload: { level: 'info', title: 'Done', body: 'Mission finished' },
        requested_by: { actor_id: 'agent:test' },
        scope: { tier: 'personal' },
      },
      { now: T0 }
    );
    expect(
      code(() =>
        respondBrowserBridgeRequest(
          note.request_id,
          { status: 'completed', result: { text: 'x' } },
          { now: at(1000) }
        )
      )
    ).toBe('invalid_response');
    expect(
      respondBrowserBridgeRequest(note.request_id, { status: 'completed' }, { now: at(1000) })
        .status
    ).toBe('completed');
  });
});

describe('awaitBrowserBridgeResponse', () => {
  it('returns the terminal record once answered, and expired after the lifetime', async () => {
    const request = observe({ ttl_ms: 60_000 });
    let clock = T0.getTime();
    let polls = 0;
    const result = await awaitBrowserBridgeResponse(request.request_id, {
      timeoutMs: 10 * 60_000,
      pollMs: 30_000,
      now: () => new Date(clock),
      sleep: async (ms) => {
        polls += 1;
        clock += ms;
      },
    });
    expect(result.status).toBe('expired');
    expect(polls).toBeGreaterThan(0);

    const answered = observe();
    respondBrowserBridgeRequest(answered.request_id, { status: 'declined' }, { now: at(1000) });
    const done = await awaitBrowserBridgeResponse(answered.request_id, {
      now: () => at(2000),
      sleep: async () => undefined,
    });
    expect(done.status).toBe('declined');
  });
});

describe('listPendingApprovalsForBridge', () => {
  it('summarizes pending, unexpired approvals with the approve command only', () => {
    const base = {
      kind: 'channel-approval',
      storageChannel: 'cli',
      channel: 'cli',
      threadTs: 't',
      correlationId: 'c',
      requestedBy: 'agent:x',
      summary: 's',
    };
    const records = [
      {
        ...base,
        id: 'a1',
        title: 'Deploy to prod',
        severity: 'high',
        status: 'pending',
        requestedAt: '2026-10-31T00:00:00.000Z',
        expiresAt: '2026-10-31T02:00:00.000Z',
      },
      {
        ...base,
        id: 'a2',
        title: 'Old',
        status: 'pending',
        requestedAt: '2026-10-30T00:00:00.000Z',
        expiresAt: '2026-10-30T01:00:00.000Z',
      },
      {
        ...base,
        id: 'a3',
        title: 'Done',
        status: 'approved',
        requestedAt: '2026-10-31T00:00:00.000Z',
      },
    ] as unknown as ApprovalRequestRecord[];
    const summaries = listPendingApprovalsForBridge({ now: at(60_000), list: () => records });
    expect(summaries).toEqual([
      {
        request_id: 'a1',
        title: 'Deploy to prod',
        risk: 'high',
        requested_at: '2026-10-31T00:00:00.000Z',
        expires_at: '2026-10-31T02:00:00.000Z',
        approve_command: 'pnpm kyberion approvals --approve a1',
      },
    ]);
  });
});

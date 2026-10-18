import { humanActor } from '@agent/core/actor';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harness, response, flush, deferred } from './ask-client-test-harness.js';
const SESSION = 'receipt-session';
const KEY = 'kyberion.ask.hearing.decision.' + SESSION;
const query = '?mode=hearing&tenant=alpha&organizationId=org-a&projectId=project-a';
const operation = {
  version: 1,
  operation_id: 'operation-1',
  scenario_id: 'web_app_build',
  requirements_revision: 4,
};
const marker = {
  version: 2,
  operation,
  conversationId: 'concierge-' + 'a'.repeat(64),
  scope: '/api/conversation?tenant=alpha&organizationId=org-a&projectId=project-a',
};
const undecided = {
  session_id: SESSION,
  scenario: 'web_app_build',
  requirements_revision: 4,
  record_revision: 4,
  requirements: [{ id: 'goal', label_key: 'goal', confidence: 1, answer: 'Private answer' }],
  canvas_versions: [],
  updated_at: '2026-10-17T00:00:00Z',
};
const record = {
  ...undecided,
  record_revision: 5,
  decided_by: { ...humanActor('member-1'), role: 'owner' },
  decided_at: '2026-10-17T00:00:00Z',
  handoff_snapshot: { version: 1, token: 'a'.repeat(64) },
};
const proof = {
  status: 'current',
  receipt: {
    operation,
    identity: {
      principal_id: 'human:viewer',
      scope_key: 'tenant:alpha',
      member_id: 'member-1',
      source: 'loopback',
    },
    namespace: 'alpha',
    session_id: SESSION,
    record_revision: 5,
    decided_at: record.decided_at,
  },
};
function setup(
  overrides: {
    proof?: unknown;
    record?: unknown;
    receiptStatus?: number;
    storage?: Map<string, string>;
    hearing?: NonNullable<Parameters<typeof harness>[0]>['hearing'];
  } = {}
) {
  return harness({
    query,
    storage:
      overrides.storage ??
      new Map([
        ['kyberion.ask.session_id', SESSION],
        [KEY, JSON.stringify(marker)],
      ]),
    hearing:
      overrides.hearing ??
      (async (url) =>
        url.includes('/decision-receipts/')
          ? response(
              { ok: true, decision_receipt: overrides.proof ?? proof },
              overrides.receiptStatus ?? 200
            )
          : response({ ok: true, record: overrides.record ?? record })),
  });
}
const check = (h: ReturnType<typeof setup>) =>
  h.elements.get('hearing-decision-check')!.fire('click');
const posts = (h: ReturnType<typeof setup>) =>
  h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
afterEach(() => vi.useRealTimers());
describe('exact hearing receipt browser recovery', () => {
  it('persists the exact revision operation before its single POST without private answers', async () => {
    const storage = new Map([['kyberion.ask.session_id', SESSION]]);
    const h = setup({
      storage,
      hearing: async (_url, init) =>
        init?.method === 'POST' ? new Promise(() => {}) : response({ ok: true, record: undecided }),
    });
    await flush();
    h.elements.get('hearing-decide')!.fire('click');
    await flush();
    const saved = JSON.parse(storage.get(KEY)!);
    expect(saved.version).toBe(2);
    expect(saved.operation).toMatchObject({
      version: 1,
      scenario_id: 'web_app_build',
      requirements_revision: 4,
    });
    expect(saved.operation.operation_id).toBeTruthy();
    expect(storage.get(KEY)).not.toContain('Private answer');
    expect(JSON.parse(posts(h)[0][1]!.body!)).toEqual(saved.operation);
    h.browserEvent('pagehide');
  });
  it('restores an exact current decision with GETs only and no automatic handoff', async () => {
    const h = setup();
    await flush();
    expect(h.storage.has(KEY)).toBe(true);
    expect(h.elements.get('hearing-decision-check')!.hidden).toBe(false);
    check(h);
    check(h);
    await flush();
    expect(posts(h)).toHaveLength(0);
    expect(h.storage.has(KEY)).toBe(false);
    expect(h.elements.get('hearing-handoff')!.disabled).toBe(false);
    expect(h.elements.get('hearing-decision-text')!.textContent).toBe(
      'front_desk:hearing_decision_recovered'
    );
    expect(h.fetch.mock.calls.filter(([url]) => url.includes('/decision-receipts/'))).toHaveLength(
      1
    );
  });
  it.each([404, 401, 403, 409, 500])(
    'keeps %s receipt failures unknown without clearing or resending',
    async (status) => {
      const h = setup({ receiptStatus: status });
      await flush();
      check(h);
      await flush();
      expect(h.storage.has(KEY)).toBe(true);
      expect(posts(h)).toHaveLength(0);
      expect(h.elements.get('hearing-handoff')!.disabled).toBe(true);
    }
  );
  it.each([
    ['superseded', { ...proof, status: 'superseded' }],
    [
      'operation',
      {
        ...proof,
        receipt: { ...proof.receipt, operation: { ...operation, operation_id: 'other' } },
      },
    ],
    [
      'revision',
      {
        ...proof,
        receipt: { ...proof.receipt, operation: { ...operation, requirements_revision: 3 } },
      },
    ],
    ['session', { ...proof, receipt: { ...proof.receipt, session_id: 'other' } }],
    [
      'actor',
      {
        ...proof,
        receipt: { ...proof.receipt, identity: { ...proof.receipt.identity, member_id: 'other' } },
      },
    ],
    ['time', { ...proof, receipt: { ...proof.receipt, decided_at: '2026-10-16T00:00:00Z' } }],
    ['record revision', { ...proof, receipt: { ...proof.receipt, record_revision: 6 } }],
    ['malformed', {}],
  ])('retains the guard for %s proof', async (_kind, value) => {
    const h = setup({ proof: value });
    await flush();
    check(h);
    await flush();
    expect(h.storage.has(KEY)).toBe(true);
    expect(posts(h)).toHaveLength(0);
    expect(h.elements.get('hearing-handoff')!.disabled).toBe(true);
  });
  it('does not query or guess an exact operation for legacy markers', async () => {
    const h = setup({
      storage: new Map([
        ['kyberion.ask.session_id', SESSION],
        [
          KEY,
          JSON.stringify({
            requestId: 'old',
            conversationId: marker.conversationId,
            scope: marker.scope,
            scenarioId: 'web_app_build',
          }),
        ],
      ]),
    });
    await flush();
    check(h);
    await flush();
    expect(h.storage.has(KEY)).toBe(true);
    expect(h.elements.get('hearing-decision-check')!.hidden).toBe(true);
    expect(h.fetch.mock.calls.some(([url]) => url.includes('/decision-receipts/'))).toBe(false);
    expect(h.elements.get('hearing-decision-text')!.textContent).toBe(
      'front_desk:hearing_decision_legacy'
    );
  });
  it.each(['revision', 'undecided'])('rejects current record %s mismatch', async (kind) => {
    const h = setup({
      record: kind === 'revision' ? { ...record, requirements_revision: 6 } : undecided,
    });
    await flush();
    check(h);
    await flush();
    expect(h.storage.has(KEY)).toBe(true);
    expect(posts(h)).toHaveLength(0);
  });
  it('retires a delayed receipt on pagehide and never accepts it after bfcache restoration', async () => {
    const wait = deferred<ReturnType<typeof response>>();
    const h = setup({
      hearing: async (url) =>
        url.includes('/decision-receipts/') ? wait.promise : response({ ok: true, record }),
    });
    await flush();
    check(h);
    await flush();
    h.browserEvent('pagehide');
    h.browserEvent('pageshow', { persisted: true });
    wait.resolve(response({ ok: true, decision_receipt: proof }));
    await flush();
    expect(h.storage.has(KEY)).toBe(true);
    expect(posts(h)).toHaveLength(0);
  });
});

it.each([200, 403])(
  'does not accept a late original POST %s after a newer superseded recovery',
  async (status) => {
    vi.useFakeTimers();
    const post = deferred<ReturnType<typeof response>>();
    const storage = new Map([['kyberion.ask.session_id', SESSION]]);
    let sent: typeof operation | undefined;
    const h = setup({
      storage,
      hearing: async (url, init) => {
        if (init?.method === 'POST') {
          sent = JSON.parse(init.body!);
          return post.promise;
        }
        if (url.includes('/decision-receipts/'))
          return response({
            ok: true,
            decision_receipt: {
              ...proof,
              status: 'superseded',
              receipt: { ...proof.receipt, operation: sent },
            },
          });
        return response({ ok: true, record: sent ? record : undecided });
      },
    });
    await flush();
    h.elements.get('hearing-decide')!.fire('click');
    await flush();
    await vi.advanceTimersByTimeAsync(60000);
    check(h);
    await flush();
    expect(h.elements.get('hearing-decision-text')!.textContent).toBe(
      'front_desk:hearing_decision_superseded'
    );
    post.resolve(
      response(
        {
          ok: status === 200,
          record,
          decision_receipt: { ...proof, receipt: { ...proof.receipt, operation: sent } },
        },
        status
      )
    );
    await flush();
    expect(h.storage.has(KEY)).toBe(true);
    expect(h.elements.get('hearing-handoff')!.disabled).toBe(true);
    expect(posts(h)).toHaveLength(1);
  }
);

it.each(['scope', 'shell', 'popstate', 'replacement', 'lost', 'remove-error'])(
  'keeps the guard when %s changes during receipt lookup',
  async (mode) => {
    const wait = deferred<ReturnType<typeof response>>();
    const h = setup({
      hearing: async (url) =>
        url.includes('/decision-receipts/') ? wait.promise : response({ ok: true, record }),
    });
    await flush();
    check(h);
    await flush();
    expect(h.fetch.mock.calls.some(([url]) => url.includes('/decision-receipts/'))).toBe(true);
    if (mode === 'scope') {
      h.window.location.search = '?mode=hearing&projectId=other';
      h.window.location.href = 'http://localhost/ask' + h.window.location.search;
    }
    if (mode === 'shell') h.shell('blocked', 'scope changed');
    if (mode === 'popstate') h.browserEvent('popstate');
    if (mode === 'replacement')
      h.storage.set(
        KEY,
        JSON.stringify({ ...marker, operation: { ...operation, operation_id: 'replacement' } })
      );
    if (mode === 'lost') h.storage.delete(KEY);
    if (mode === 'remove-error')
      h.window.sessionStorage.removeItem = () => {
        throw Error('blocked');
      };
    wait.resolve(response({ ok: true, decision_receipt: proof }));
    await flush();
    expect(h.elements.get('hearing-handoff')!.disabled).toBe(true);
    expect(h.elements.get('ask-send')!.disabled).toBe(true);
    expect(posts(h)).toHaveLength(0);
    if (mode !== 'lost') expect(h.storage.has(KEY)).toBe(true);
  }
);
it('times out a receipt read, ignores its late success, then permits a new GET-only check', async () => {
  vi.useFakeTimers();
  const wait = deferred<ReturnType<typeof response>>();
  let reads = 0;
  const h = setup({
    hearing: async (url) =>
      url.includes('/decision-receipts/')
        ? ++reads === 1
          ? wait.promise
          : response({ ok: true, decision_receipt: proof })
        : response({ ok: true, record }),
  });
  await flush();
  check(h);
  await flush();
  expect(h.elements.get('hearing-decision-text')!.textContent).toBe(
    'front_desk:hearing_decision_checking'
  );
  await vi.advanceTimersByTimeAsync(20000);
  await flush();
  expect(h.storage.has(KEY)).toBe(true);
  expect(h.elements.get('hearing-decision-check')!.disabled).toBe(false);
  wait.resolve(response({ ok: true, decision_receipt: proof }));
  await flush();
  expect(h.storage.has(KEY)).toBe(true);
  check(h);
  await flush();
  expect(h.storage.has(KEY)).toBe(false);
  expect(reads).toBe(2);
  expect(posts(h)).toHaveLength(0);
});
it('times out a stalled record read without requesting proof or unlocking', async () => {
  vi.useFakeTimers();
  let reads = 0;
  const h = setup({
    hearing: async () => (++reads === 1 ? response({ ok: true, record }) : new Promise(() => {})),
  });
  await flush();
  check(h);
  await flush();
  await vi.advanceTimersByTimeAsync(20000);
  await flush();
  expect(h.storage.has(KEY)).toBe(true);
  expect(h.fetch.mock.calls.some(([url]) => url.includes('/decision-receipts/'))).toBe(false);
  expect(h.elements.get('hearing-decision-check')!.disabled).toBe(false);
});
it('restores an already completed destination only after exact proof, without executing it', async () => {
  const h = setup({
    hearing: async (url) =>
      url.includes('/decision-receipts/')
        ? response({ ok: true, decision_receipt: proof })
        : response({
            ok: true,
            record,
            completion: {
              kind: 'mission',
              status: 'ready',
              id: 'mission-1',
              next: { href: '/decide?missionId=mission-1' },
            },
          }),
  });
  await flush();
  check(h);
  await flush();
  expect(h.storage.has(KEY)).toBe(false);
  expect(h.elements.get('hearing-handoff-link')!.attributes.href).toContain('missionId=mission-1');
  expect(h.elements.get('hearing-handoff')!.classList.toggle).toHaveBeenLastCalledWith(
    'hidden',
    true
  );
  expect(posts(h)).toHaveLength(0);
});

it('uses the snapshot from the exact receipt recovery view on the next explicit handoff', async () => {
  const snapshot = { version: 1, token: 'b'.repeat(64) };
  const h = setup({
    hearing: async (url, init) =>
      init?.method === 'POST'
        ? response({ ok: true, mission_id: 'MISSION-1', next_action: { href: '/result' } })
        : url.includes('/decision-receipts/')
          ? response({ ok: true, decision_receipt: proof })
          : response({ ok: true, record: { ...record, handoff_snapshot: snapshot } }),
  });
  await flush();
  check(h);
  await flush();
  expect(h.storage.has(KEY)).toBe(false);
  expect(posts(h)).toHaveLength(0);
  const readsBefore = h.fetch.mock.calls.filter(
    ([url, init]) => url.startsWith('/api/hearing/') && init?.method !== 'POST'
  ).length;
  h.elements.get('hearing-handoff')!.fire('click');
  await flush();
  expect(posts(h)).toHaveLength(1);
  expect(posts(h)[0][0]).toContain('/handoff?');
  expect(JSON.parse(posts(h)[0][1]!.body!)).toEqual({ handoff_snapshot: snapshot });
  expect(
    h.fetch.mock.calls.filter(
      ([url, init]) => url.startsWith('/api/hearing/') && init?.method !== 'POST'
    )
  ).toHaveLength(readsBefore);
});

it.each([undefined, { version: 1, token: 'malformed' }])(
  'does not infer handoff proof from exact receipt recovery %#',
  async (snapshot) => {
    const h = setup({ record: { ...record, handoff_snapshot: snapshot } });
    await flush();
    check(h);
    await flush();
    expect(h.storage.has(KEY)).toBe(false);
    expect(h.elements.get('hearing-handoff')!.disabled).toBe(true);
    h.elements.get('hearing-handoff')!.fire('click');
    await flush();
    expect(posts(h)).toHaveLength(0);
    expect(h.storage.has('kyberion.ask.hearing.completion.' + SESSION)).toBe(false);
  }
);

import { ASK_VOCABULARY_KEYS } from './front-desk-pages.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harness, response, flush, deferred } from './ask-client-test-harness.js';
const SESSION = 'decision-session';
const KEY = 'kyberion.ask.hearing.decision.' + SESSION;
const record = {
  session_id: SESSION,
  scenario: 'web_app_build',
  requirements: [{ id: 'goal', label_key: 'goal', confidence: 1, answer: 'Private answer' }],
  canvas_versions: [],
  updated_at: '2026-10-17T00:00:00Z',
};
const decided = {
  ...record,
  decided_by: { kind: 'human', id: 'MEMBER-1', role: 'owner' },
  decided_at: '2026-10-17T00:00:00Z',
};
function setup(
  post: () => Promise<ReturnType<typeof response>> = () => new Promise(() => {}),
  storage = new Map([['kyberion.ask.session_id', SESSION]])
) {
  return harness({
    storage,
    query: '?mode=hearing&tenant=alpha&organizationId=org-a&projectId=project-a',
    hearing: async (_url, init) =>
      init?.method === 'POST' ? post() : response({ ok: true, record }),
  });
}
const click = (h: ReturnType<typeof setup>) => h.elements.get('hearing-decide')!.fire('click');
const posts = (h: ReturnType<typeof setup>) =>
  h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
afterEach(() => vi.useRealTimers());
describe('hearing decision uncertainty', () => {
  it('durably guards before dispatch and blocks every hearing mutation synchronously', async () => {
    const h = setup();
    await flush();
    click(h);
    click(h);
    h.elements.get('hearing-handoff')!.fire('click');
    h.input.value = 'another answer';
    h.form.fire('submit');
    await flush();
    expect(posts(h)).toHaveLength(1);
    expect(h.storage.get(KEY)).toBeTruthy();
    expect(h.storage.get(KEY)).not.toContain('Private answer');
    expect(h.elements.get('hearing-decide')!.disabled).toBe(true);
    expect(h.elements.get('ask-send')!.disabled).toBe(true);
    expect(h.elements.get('hearing-decision-text')!.textContent).toBe(
      'front_desk:hearing_decision_pending'
    );
  });
  it('reaches unknown at the deadline without resending', async () => {
    vi.useFakeTimers();
    const h = setup();
    await flush();
    click(h);
    await flush();
    await vi.advanceTimersByTimeAsync(60000);
    await flush();
    expect(h.elements.get('hearing-decision-text')!.textContent).toBe(
      'front_desk:hearing_decision_unknown'
    );
    expect(h.elements.get('hearing-decision-status')!.attributes['aria-busy']).toBe('false');
    click(h);
    await flush();
    expect(posts(h)).toHaveLength(1);
    expect(h.storage.has(KEY)).toBe(true);
  });
  it.each([400, 401, 403])('releases only explicit pre-write rejection %s', async (status) => {
    const h = setup(async () => response({ ok: false }, status));
    await flush();
    click(h);
    await flush();
    expect(h.storage.has(KEY)).toBe(false);
    expect(h.elements.get('hearing-decide')!.disabled).toBe(false);
    expect(h.elements.get('hearing-decision-text')!.textContent).toBe(
      'front_desk:hearing_decision_rejected'
    );
  });
  it.each([
    'network',
    '500',
    'malformed',
    'wrong-session',
    'wrong-scenario',
    'missing-decided',
    'bad-requirements',
  ])('keeps %s unknown on reload and permits ordinary conversation', async (kind) => {
    const h = setup(async () => {
      if (kind === 'network') throw Error('Offline');
      return response(
        kind === '500'
          ? { ok: false }
          : kind === 'malformed'
            ? {}
            : {
                ok: true,
                record:
                  kind === 'wrong-session'
                    ? { ...decided, session_id: 'other' }
                    : kind === 'wrong-scenario'
                      ? { ...decided, scenario: 'other' }
                      : kind === 'missing-decided'
                        ? record
                        : { ...decided, requirements: [null] },
              },
        kind === '500' ? 500 : 200
      );
    });
    await flush();
    click(h);
    await flush();
    expect(h.storage.has(KEY)).toBe(true);
    expect(h.elements.get('hearing-decision-text')!.textContent).toBe(
      'front_desk:hearing_decision_unknown'
    );
    const restored = setup(undefined, h.storage);
    await flush();
    click(restored);
    await flush();
    expect(posts(restored)).toHaveLength(0);
    expect(restored.elements.get('ask-send')!.disabled).toBe(true);
    const href = restored.elements.get('hearing-decision-continue')!.attributes.href;
    expect(href).toContain('organizationId=org-a');
    expect(href).not.toContain('mode=hearing');
    const ordinary = harness({ storage: h.storage });
    await flush();
    expect(ordinary.elements.get('ask-send')!.disabled).toBe(false);
    expect(h.storage.has(KEY)).toBe(true);
  });
  it('accepts only its exact valid success', async () => {
    const h = setup(async () => response({ ok: true, record: decided }));
    await flush();
    click(h);
    await flush();
    expect(h.storage.has(KEY)).toBe(false);
    expect(h.elements.get('hearing-handoff')!.disabled).toBe(false);
  });
  it('fails closed when persistence throws before dispatch', async () => {
    const h = setup();
    await flush();
    h.window.sessionStorage.setItem = () => {
      throw Error('quota');
    };
    click(h);
    await flush();
    expect(posts(h)).toHaveLength(0);
    expect(h.elements.get('hearing-decide')!.disabled).toBe(true);
    expect(h.elements.get('hearing-decision-text')!.textContent).toBe(
      'front_desk:hearing_decision_storage'
    );
  });
  it('does not unlock from GET or BFCache restoration', async () => {
    vi.useFakeTimers();
    const h = setup();
    await flush();
    click(h);
    await flush();
    h.browserEvent('pagehide');
    h.browserEvent('pageshow', { persisted: true });
    h.browserEvent('popstate');
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    click(h);
    await flush();
    expect(posts(h)).toHaveLength(1);
    expect(h.storage.has(KEY)).toBe(true);
    expect(h.elements.get('hearing-decide')!.disabled).toBe(true);
  });
  it.each([200, 403])('does not clear a replacement marker from late %s', async (status) => {
    const d = deferred<ReturnType<typeof response>>();
    const h = setup(() => d.promise);
    await flush();
    click(h);
    await flush();
    const other = JSON.stringify({ ...JSON.parse(h.storage.get(KEY)!), requestId: 'replacement' });
    h.storage.set(KEY, other);
    d.resolve(response({ ok: status === 200, record: decided }, status));
    await flush();
    expect(h.storage.get(KEY)).toBe(other);
    expect(h.elements.get('hearing-decide')!.disabled).toBe(true);
  });
});

it.each([200, 403])('settles its own late %s response after deadline', async (status) => {
  vi.useFakeTimers();
  const d = deferred<ReturnType<typeof response>>();
  const h = setup(() => d.promise);
  await flush();
  click(h);
  await flush();
  await vi.advanceTimersByTimeAsync(60000);
  expect(h.storage.has(KEY)).toBe(true);
  d.resolve(response({ ok: status === 200, record: decided }, status));
  await flush();
  expect(h.storage.has(KEY)).toBe(false);
  expect(h.elements.get('hearing-decide')!.disabled).toBe(false);
});
it.each([200, 403])(
  'does not publish a stale %s payload after scope navigation',
  async (status) => {
    const d = deferred<ReturnType<typeof response>>();
    const h = setup(() => d.promise);
    await flush();
    click(h);
    await flush();
    h.window.location.search = '?mode=hearing&projectId=other';
    h.window.location.href = 'http://localhost/ask' + h.window.location.search;
    h.shell('blocked', 'scope changed');
    d.resolve(
      response(
        {
          ok: status === 200,
          record: { ...decided, requirements: [{ answer: 'stale' }, { answer: 'stale' }] },
        },
        status
      )
    );
    await flush();
    expect(h.elements.get('hearing-decision-text')!.textContent).not.toBe(
      'front_desk:hearing_decision_rejected'
    );
    expect(h.elements.get('hearing-handoff')!.classList.toggle).not.toHaveBeenLastCalledWith(
      'hidden',
      false
    );
  }
);
it.each(['read', 'remove', 'lost', 'overwrite'])(
  'fails closed on storage %s after dispatch',
  async (mode) => {
    const d = deferred<ReturnType<typeof response>>();
    const h = setup(() => d.promise);
    await flush();
    click(h);
    await flush();
    if (mode === 'read')
      h.window.sessionStorage.getItem = () => {
        throw Error('blocked');
      };
    if (mode === 'remove')
      h.window.sessionStorage.removeItem = () => {
        throw Error('blocked');
      };
    if (mode === 'lost') h.storage.delete(KEY);
    if (mode === 'overwrite') h.storage.set(KEY, 'malformed foreign marker');
    d.resolve(response({ ok: true, record: decided }));
    await flush();
    click(h);
    await flush();
    expect(posts(h)).toHaveLength(1);
    expect(h.elements.get('hearing-decide')!.disabled).toBe(true);
  }
);
it('fails closed when marker verification fails before dispatch', async () => {
  const h = setup();
  await flush();
  h.window.sessionStorage.setItem = () => h.storage;
  click(h);
  await flush();
  expect(posts(h)).toHaveLength(0);
  expect(h.elements.get('hearing-decide')!.disabled).toBe(true);
});
it('keeps a different session usable with an affected session marker', async () => {
  const first = setup();
  await flush();
  click(first);
  await flush();
  const storage = new Map(first.storage);
  storage.set('kyberion.ask.session_id', 'unaffected-session');
  const h = harness({
    storage,
    query: '?mode=hearing',
    hearing: async () =>
      response({ ok: true, record: { ...record, session_id: 'unaffected-session' } }),
  });
  await flush();
  expect(h.elements.get('hearing-decide')!.disabled).toBe(false);
  expect(h.elements.get('ask-send')!.disabled).toBe(false);
  expect(storage.has(KEY)).toBe(true);
});
it('does not treat a restored completed destination as this decision receipt', async () => {
  const first = setup();
  await flush();
  click(first);
  await flush();
  const h = harness({
    storage: first.storage,
    query: '?mode=hearing',
    hearing: async () =>
      response({
        ok: true,
        record: decided,
        completion: { kind: 'mission', status: 'ready', id: 'SAVED', next: { href: '/review' } },
      }),
  });
  await flush();
  expect(h.elements.get('hearing-handoff-link')!.attributes.href).toContain('/review');
  expect(h.elements.get('hearing-decision-text')!.textContent).toBe(
    'front_desk:hearing_decision_unknown'
  );
  expect(h.elements.get('ask-send')!.disabled).toBe(true);
  expect(h.storage.has(KEY)).toBe(true);
});
it('includes stalled JSON parsing in the deadline', async () => {
  vi.useFakeTimers();
  const h = setup(async () => ({ ...response({}), json: () => new Promise(() => {}) }));
  await flush();
  click(h);
  await flush();
  await vi.advanceTimersByTimeAsync(60000);
  expect(h.elements.get('hearing-decision-text')!.textContent).toBe(
    'front_desk:hearing_decision_unknown'
  );
  expect(posts(h)).toHaveLength(1);
});
it.each([
  null,
  [],
  { ...decided, decided_at: true },
  { ...decided, decided_at: 'invalid' },
  { ...decided, requirements: [] },
  { ...decided, requirements: [{ answer: 42 }] },
  { ...decided, requirements: [{ answer: '' }] },
])('rejects malformed success shape %#', async (value) => {
  const h = setup(async () => response({ ok: true, record: value }));
  await flush();
  click(h);
  await flush();
  expect(h.storage.has(KEY)).toBe(true);
  expect(h.elements.get('hearing-decision-text')!.textContent).toBe(
    'front_desk:hearing_decision_unknown'
  );
});
it('blocks work inventory save while decide is unresolved', async () => {
  const h = harness({
    query: '?mode=hearing&scenario=work_inventory',
    storage: new Map([['kyberion.ask.session_id', SESSION]]),
    hearing: async (_url, init) =>
      init?.method === 'POST'
        ? new Promise(() => {})
        : response({ ok: true, record: { ...record, scenario: 'work_inventory' } }),
  });
  await flush();
  click(h);
  h.elements.get('hearing-handoff')!.fire('click');
  await flush();
  expect(posts(h)).toHaveLength(1);
});

it.each([
  null,
  { kind: 'human', id: 'MEMBER-1', role: 'viewer' },
  { kind: 'agent', id: 'AGENT-1', role: 'owner' },
  { kind: 'human', id: '', role: 'owner' },
])('retains unknown for invalid decision actor %#', async (actor) => {
  const h = setup(async () => response({ ok: true, record: { ...decided, decided_by: actor } }));
  await flush();
  click(h);
  await flush();
  expect(h.storage.has(KEY)).toBe(true);
});

it('keeps retired success guarded after stale BFCache GET and later renders', async () => {
  vi.useFakeTimers();
  const d = deferred<ReturnType<typeof response>>();
  const h = setup(() => d.promise);
  await flush();
  click(h);
  await flush();
  h.browserEvent('pagehide');
  h.browserEvent('pageshow', { persisted: true });
  h.browserEvent('popstate');
  await vi.advanceTimersByTimeAsync(0);
  await flush();
  d.resolve(response({ ok: true, record: decided }));
  await flush();
  h.input.fire('input');
  click(h);
  await flush();
  expect(h.storage.has(KEY)).toBe(true);
  expect(posts(h)).toHaveLength(1);
  expect(h.elements.get('hearing-decide')!.disabled).toBe(true);
});
it('ignores a hidden decide handler on an already decided record', async () => {
  const h = harness({
    query: '?mode=hearing',
    storage: new Map([['kyberion.ask.session_id', SESSION]]),
    hearing: async () => response({ ok: true, record: decided }),
  });
  await flush();
  h.elements.get('hearing-handoff')!.fire('click');
  click(h);
  await flush();
  expect(posts(h).filter(([url]) => url.includes('/decide'))).toHaveLength(0);
});

it('registers every decision status in the real ask vocabulary', () => {
  for (const suffix of ['pending', 'unknown', 'storage', 'rejected', 'continue'])
    expect(ASK_VOCABULARY_KEYS).toContain('front_desk:hearing_decision_' + suffix);
});

it('fails closed on an empty persisted marker across every hearing mutation', async () => {
  const storage = new Map([
    ['kyberion.ask.session_id', SESSION],
    [KEY, ''],
  ]);
  const h = setup(undefined, storage);
  await flush();
  click(h);
  h.elements.get('hearing-handoff')!.fire('click');
  h.input.value = 'answer';
  h.form.fire('submit');
  await flush();
  expect(posts(h)).toHaveLength(0);
  expect(h.elements.get('ask-send')!.disabled).toBe(true);
  expect(storage.get(KEY)).toBe('');
});

it.each(['stale_snapshot', 'completion_locked', 'handoff_unresolved'])(
  'explains %s without releasing the decision guard, even after a successful GET',
  async (code) => {
    const h = setup(async () => response({ ok: false, hearing_conflict: code }, 409));
    await flush();
    click(h);
    await flush();
    expect(h.elements.get('hearing-decision-text')!.textContent).toContain(
      'front_desk:hearing_conflict_' + code
    );
    expect(h.elements.get('hearing-decision-text')!.textContent).toContain(
      'front_desk:hearing_decision_unknown'
    );
    expect(h.storage.has(KEY)).toBe(true);
    click(h);
    await flush();
    expect(posts(h)).toHaveLength(1);
    const restored = setup(undefined, h.storage);
    await flush();
    expect(restored.elements.get('ask-send')!.disabled).toBe(true);
    expect(h.storage.has(KEY)).toBe(true);
    expect(ASK_VOCABULARY_KEYS).toContain('front_desk:hearing_conflict_' + code);
  }
);
it('does not publish an unrecognized conflict payload', async () => {
  const h = setup(async () => response({ ok: false, hearing_conflict: '<private payload>' }, 409));
  await flush();
  click(h);
  await flush();
  expect(h.elements.get('hearing-decision-text')!.textContent).toBe(
    'front_desk:hearing_decision_unknown'
  );
  expect(h.storage.has(KEY)).toBe(true);
});

it('does not publish a retired conflict after navigation', async () => {
  const d = deferred<ReturnType<typeof response>>();
  const h = setup(() => d.promise);
  await flush();
  click(h);
  await flush();
  h.browserEvent('pagehide');
  d.resolve(response({ ok: false, hearing_conflict: 'stale_snapshot' }, 409));
  await flush();
  expect(h.elements.get('hearing-decision-text')!.textContent).not.toContain('hearing_conflict');
  expect(h.storage.has(KEY)).toBe(true);
});

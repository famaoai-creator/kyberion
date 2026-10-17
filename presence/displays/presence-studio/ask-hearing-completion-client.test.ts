import { describe, it, expect, vi } from 'vitest';
import { harness, response, flush, deferred } from './ask-client-test-harness.js';
const SESSION = 'completion-session';
function setup(kind: 'mission' | 'inventory', completion: unknown) {
  const scenario = kind === 'inventory' ? 'work_inventory' : 'web_app_build';
  return harness({
    texts: new Proxy(
      {},
      {
        get: (_target, key) =>
          String(key).endsWith('_label') ? String(key) + ' {id}' : String(key),
      }
    ),
    query:
      '?mode=hearing&scenario=' +
      scenario +
      '&tenant=alpha&organizationId=org-a&projectId=project-a',
    storage: new Map([['kyberion.ask.session_id', SESSION]]),
    hearing: async () =>
      response({
        ok: true,
        record: {
          session_id: SESSION,
          scenario,
          requirements: [{ answer: 'Done' }],
          decided_at: '2026-10-17T00:00:00Z',
        },
        completion,
      }),
  });
}
describe('completed hearing read recovery', () => {
  it.each(['mission', 'inventory'] as const)(
    'restores %s completion on fresh load without any POST',
    async (kind) => {
      const h = setup(kind, {
        kind,
        status: 'ready',
        id: 'SYNTHETIC-1',
        next: { href: kind === 'mission' ? 'http://127.0.0.1:3000/' : '/progress' },
      });
      await flush();
      expect(h.elements.get('hearing-handoff-status')!.textContent).toContain('SYNTHETIC-1');
      expect(h.elements.get('hearing-handoff-link')!.attributes.href).toContain('tenant=alpha');
      expect(h.elements.get('hearing-handoff-link')!.attributes.href).toContain(
        'organizationId=org-a'
      );
      expect(h.elements.get('hearing-handoff-link')!.attributes.href).toContain(
        'projectId=project-a'
      );
      expect(h.elements.get('hearing-handoff')!.classList.toggle).toHaveBeenLastCalledWith(
        'hidden',
        true
      );
      expect(h.fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
    }
  );
  it.each(['mission', 'inventory'] as const)(
    'keeps unavailable %s completion non-actionable',
    async (kind) => {
      const h = setup(kind, { kind, status: 'unavailable' });
      await flush();
      expect(h.elements.get('hearing-handoff-status')!.textContent).toBe(
        'front_desk:hearing_completion_unavailable'
      );
      expect(h.elements.get('hearing-handoff')!.classList.toggle).toHaveBeenLastCalledWith(
        'hidden',
        true
      );
      expect(h.elements.get('hearing-handoff-link')!.attributes.href ?? '').toBe('');
    }
  );
  it.each([
    'javascript:alert(1)',
    'data:text/html,bad',
    '//evil.test/',
    'http://user:pass@localhost/',
    '/ask?send=1',
  ])('does not expose unsafe completion URL %s', async (href) => {
    const h = setup('mission', {
      kind: 'mission',
      status: 'ready',
      id: 'SYNTHETIC-1',
      next: { href },
    });
    await flush();
    expect(h.elements.get('hearing-handoff-link')!.attributes.href ?? '').toBe('');
    expect(h.elements.get('hearing-handoff-status')!.textContent).toBe(
      'front_desk:hearing_completion_unavailable'
    );
  });
});

it('hides a verified completion when scope readiness is lost', async () => {
  const h = setup('mission', {
    kind: 'mission',
    status: 'ready',
    id: 'SYNTHETIC-1',
    next: { href: 'https://review.example.test/' },
  });
  await flush();
  expect(h.elements.get('hearing-handoff-link')!.attributes.href).toContain('review.example.test');
  h.shell('blocked', 'Different scope');
  await flush();
  expect(h.elements.get('hearing-handoff-link')!.attributes.href).toBe('');
  expect(h.elements.get('hearing-handoff-status')!.textContent).not.toContain('SYNTHETIC-1');
  expect(h.elements.get('hearing-handoff')!.classList.toggle).toHaveBeenLastCalledWith(
    'hidden',
    true
  );
});
it('ignores retired completion reads after navigation', async () => {
  vi.useFakeTimers();
  try {
    const old = deferred<ReturnType<typeof response>>();
    let calls = 0;
    const record = {
      session_id: SESSION,
      scenario: 'web_app_build',
      requirements: [{ answer: 'Done' }],
      decided_at: '2026-10-17T00:00:00Z',
    };
    const h = harness({
      query: '?mode=hearing',
      storage: new Map([['kyberion.ask.session_id', SESSION]]),
      hearing: async () =>
        ++calls === 1
          ? old.promise
          : response({ ok: true, record, completion: { kind: 'mission', status: 'unavailable' } }),
    });
    await flush();
    h.browserEvent('pagehide');
    h.browserEvent('pageshow', { persisted: true });
    h.browserEvent('popstate');
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    old.resolve(
      response({
        ok: true,
        record,
        completion: {
          kind: 'mission',
          status: 'ready',
          id: 'OLD-SECRET',
          next: { href: 'https://old.example.test/' },
        },
      })
    );
    await flush();
    expect(h.elements.get('hearing-handoff-status')!.textContent).not.toContain('OLD-SECRET');
    expect(h.elements.get('hearing-handoff-link')!.attributes.href ?? '').toBe('');
    expect(h.fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it.each(['mission', 'inventory'] as const)(
  'preserves %s POST success and restores it on reload with GET only',
  async (kind) => {
    const scenario = kind === 'inventory' ? 'work_inventory' : 'web_app_build';
    const storage = new Map([['kyberion.ask.session_id', SESSION]]);
    let saved = false;
    const record = {
      session_id: SESSION,
      scenario,
      requirements: [{ answer: 'Done' }],
      decided_at: '2026-10-17T00:00:00Z',
    };
    const completion = {
      kind,
      status: 'ready',
      id: 'SYNTHETIC-POST',
      next: { href: 'https://review.example.test/' },
    };
    const handler = async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        saved = true;
        return response(
          kind === 'mission'
            ? {
                ok: true,
                mission_id: 'SYNTHETIC-POST',
                next_action: { href: 'https://review.example.test/' },
              }
            : {
                ok: true,
                entry_id: 'SYNTHETIC-POST',
                next: { href: 'https://review.example.test/' },
              }
        );
      }
      return response({ ok: true, record, completion: saved ? completion : undefined });
    };
    const options = { storage, query: '?mode=hearing&scenario=' + scenario, hearing: handler };
    const first = harness(options);
    await flush();
    first.elements.get('hearing-handoff')!.fire('click');
    await flush();
    expect(first.elements.get('hearing-handoff-status')!.textContent).toContain(
      kind === 'mission' ? 'hearing_handoff_done' : 'hearing_inventory_done'
    );
    const restored = harness(options);
    await flush();
    expect(restored.elements.get('hearing-handoff-status')!.textContent).toContain(
      kind === 'mission' ? 'hearing_handoff_done' : 'hearing_inventory_done'
    );
    expect(restored.fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  }
);
it.each(['mission', 'inventory'] as const)(
  'ignores late %s POST success after scope change',
  async (kind) => {
    const pending = deferred<ReturnType<typeof response>>();
    const scenario = kind === 'inventory' ? 'work_inventory' : 'web_app_build';
    const h = harness({
      query: '?mode=hearing&scenario=' + scenario,
      storage: new Map([['kyberion.ask.session_id', SESSION]]),
      hearing: async (_url, init) =>
        init?.method === 'POST'
          ? pending.promise
          : response({
              ok: true,
              record: {
                session_id: SESSION,
                scenario,
                requirements: [{ answer: 'Done' }],
                decided_at: '2026-10-17T00:00:00Z',
              },
            }),
    });
    await flush();
    h.elements.get('hearing-handoff')!.fire('click');
    h.shell('blocked', 'Changed scope');
    pending.resolve(
      response(
        kind === 'mission'
          ? { ok: true, mission_id: 'OLD-POST', next_action: { href: 'https://old.example.test/' } }
          : { ok: true, entry_id: 'OLD-POST', next: { href: 'https://old.example.test/' } }
      )
    );
    await flush();
    expect(h.elements.get('hearing-handoff-link')!.attributes.href ?? '').toBe('');
    expect(h.elements.get('hearing-handoff-status')!.textContent).not.toContain(
      'hearing_handoff_done'
    );
    expect(h.elements.get('hearing-handoff-status')!.textContent).not.toContain(
      'hearing_inventory_done'
    );
  }
);

it.each(['mission', 'inventory'] as const)(
  'retires pre-POST canvas GET before %s succeeds',
  async (kind) => {
    vi.useFakeTimers();
    try {
      const scenario = kind === 'inventory' ? 'work_inventory' : 'web_app_build';
      let gets = 0;
      const old = deferred<ReturnType<typeof response>>();
      const record = {
        session_id: SESSION,
        scenario,
        requirements: [{ answer: 'Done' }],
        decided_at: '2026-10-17T00:00:00Z',
        canvas_generation: 'pending',
      };
      const h = harness({
        query: '?mode=hearing&scenario=' + scenario,
        storage: new Map([['kyberion.ask.session_id', SESSION]]),
        hearing: async (_url, init) => {
          if (init?.method === 'POST')
            return response(
              kind === 'mission'
                ? { ok: true, mission_id: 'NEW-RESULT', next_action: { href: '/result' } }
                : { ok: true, entry_id: 'NEW-RESULT', next: { href: '/result' } }
            );
          return ++gets === 1 ? response({ ok: true, record }) : old.promise;
        },
      });
      await flush();
      await vi.advanceTimersByTimeAsync(3000);
      await flush();
      expect(gets).toBe(2);
      h.elements.get('hearing-handoff')!.fire('click');
      await flush();
      old.resolve(response({ ok: true, record }));
      await flush();
      expect(h.elements.get('hearing-handoff-status')!.textContent).toContain(
        kind === 'mission' ? 'hearing_handoff_done' : 'hearing_inventory_done'
      );
      expect(h.elements.get('hearing-handoff-link')!.attributes.href).toContain('/result');
      expect(h.elements.get('hearing-handoff')!.classList.toggle).toHaveBeenLastCalledWith(
        'hidden',
        true
      );
    } finally {
      vi.useRealTimers();
    }
  }
);
it.each(['mission', 'inventory'] as const)(
  'releases only the definitively rejected %s action after BFCache',
  async (kind) => {
    vi.useFakeTimers();
    try {
      const scenario = kind === 'inventory' ? 'work_inventory' : 'web_app_build';
      const pending = deferred<ReturnType<typeof response>>();
      let posts = 0;
      const record = {
        session_id: SESSION,
        scenario,
        requirements: [{ answer: 'Done' }],
        decided_at: '2026-10-17T00:00:00Z',
      };
      const h = harness({
        query: '?mode=hearing&scenario=' + scenario,
        storage: new Map([['kyberion.ask.session_id', SESSION]]),
        hearing: async (_url, init) => {
          if (init?.method === 'POST') {
            posts++;
            return posts === 1 ? pending.promise : response({ ok: false }, 403);
          }
          return response({ ok: true, record });
        },
      });
      await flush();
      h.elements.get('hearing-handoff')!.fire('click');
      await flush();
      expect(posts).toBe(1);
      h.browserEvent('pagehide');
      pending.resolve(response({ ok: false, error: 'Forbidden' }, 403));
      await flush();
      h.browserEvent('pageshow', { persisted: true });
      h.browserEvent('popstate');
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      expect(posts).toBe(1);
      h.elements.get('hearing-handoff')!.fire('click');
      await flush();
      expect(posts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  }
);
it('does not release an unresolved completion solely on a missing GET result after BFCache', async () => {
  vi.useFakeTimers();
  try {
    const h = harness({
      query: '?mode=hearing',
      storage: new Map([['kyberion.ask.session_id', SESSION]]),
      hearing: async (_url, init) =>
        init?.method === 'POST'
          ? new Promise(() => {})
          : response({
              ok: true,
              record: {
                session_id: SESSION,
                scenario: 'web_app_build',
                requirements: [{ answer: 'Done' }],
                decided_at: '2026-10-17T00:00:00Z',
              },
            }),
    });
    await flush();
    h.elements.get('hearing-handoff')!.fire('click');
    await flush();
    h.browserEvent('pagehide');
    h.browserEvent('pageshow', { persisted: true });
    h.browserEvent('popstate');
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    h.elements.get('hearing-handoff')!.fire('click');
    await flush();
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it('preserves an ambiguous retired server error guard despite GET absence', async () => {
  vi.useFakeTimers();
  try {
    const pending = deferred<ReturnType<typeof response>>();
    let posts = 0;
    const h = harness({
      query: '?mode=hearing&scenario=work_inventory',
      storage: new Map([['kyberion.ask.session_id', SESSION]]),
      hearing: async (_url, init) => {
        if (init?.method === 'POST') {
          posts++;
          return pending.promise;
        }
        return response({
          ok: true,
          record: {
            session_id: SESSION,
            scenario: 'work_inventory',
            requirements: [{ answer: 'Done' }],
            decided_at: '2026-10-17T00:00:00Z',
          },
        });
      },
    });
    await flush();
    h.elements.get('hearing-handoff')!.fire('click');
    await flush();
    h.browserEvent('pagehide');
    pending.resolve(response({ ok: false, error: 'May have saved before failure' }, 500));
    await flush();
    h.browserEvent('pageshow', { persisted: true });
    h.browserEvent('popstate');
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    h.elements.get('hearing-handoff')!.fire('click');
    await flush();
    expect(posts).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

it('fails closed for hearing mutations when the completion helper is unavailable', async () => {
  const h = harness({ completionScript: false, query: '?mode=hearing&scenario=work_inventory' });
  await flush();
  h.elements.get('hearing-decide')!.fire('click');
  h.elements.get('hearing-handoff')!.fire('click');
  await flush();
  expect(h.elements.get('ask-send')!.disabled).toBe(true);
  expect(h.fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
});
it('keeps ordinary conversation available without the completion helper', async () => {
  const h = harness({ completionScript: false });
  await flush();
  expect(h.elements.get('ask-send')!.disabled).toBe(false);
});

describe('completion conflict explanations', () => {
  it.each(['handoff', 'inventory'])(
    'explains every bounded %s conflict without publishing a destination',
    async (endpoint) => {
      for (const code of ['stale_snapshot', 'completion_locked', 'handoff_unresolved']) {
        const scenario = endpoint === 'inventory' ? 'work_inventory' : 'web_app_build';
        const h = harness({
          query: '?mode=hearing&scenario=' + scenario,
          storage: new Map([['kyberion.ask.session_id', SESSION]]),
          hearing: async (_url, init) =>
            init?.method === 'POST'
              ? response({ ok: false, hearing_conflict: code }, 409)
              : response({
                  ok: true,
                  record: {
                    session_id: SESSION,
                    scenario,
                    requirements: [{ answer: 'Done' }],
                    decided_at: '2026-10-17T00:00:00Z',
                  },
                }),
        });
        await flush();
        h.elements.get('hearing-handoff')!.fire('click');
        await flush();
        expect(h.elements.get('hearing-handoff-status')!.textContent).toBe(
          'front_desk:hearing_conflict_' + code
        );
        expect(h.elements.get('hearing-handoff-link')!.attributes.href ?? '').toBe('');
        if (code !== 'stale_snapshot') {
          expect(h.elements.get('hearing-handoff')!.disabled).toBe(true);
          // Invoke even a disabled button's handler to verify dispatch is guarded.
          h.elements.get('hearing-handoff')!.fire('click');
          await flush();
        }
        expect(
          h.fetch.mock.calls.filter(
            ([url, init]) => url.includes('/' + endpoint) && init?.method === 'POST'
          )
        ).toHaveLength(1);
      }
    }
  );
});

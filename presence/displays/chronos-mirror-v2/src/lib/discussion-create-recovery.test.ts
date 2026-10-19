import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDiscussion,
  fetchDiscussionRequest,
  fetchDiscussionRequestContext,
  type DiscussionCreateInput,
} from './discussion-client';
import {
  createDiscussionRecoveryController,
  discussionCreationBlocked,
  discussionRequestProof,
  DISCUSSION_PENDING_PREFIX,
  type DiscussionCreateHandle,
} from './discussion-create-recovery';

const ID = '7bf285c3-ab12-49bd-93b2-899885ebdd88';
const OTHER = '32376722-f606-4799-a683-e0486cd090e1';
const DIGEST = 'a'.repeat(64);
const input: DiscussionCreateInput = {
  goal: 'confidential source',
  locale: 'en',
  speaker: 'reasoning',
  provider: 'claude',
  turn_delay_ms: 700,
  tenant: 'original-tenant',
  organization_id: 'original-org',
  project_id: 'original-project',
  mission_id: 'original-mission',
};
const handle: DiscussionCreateHandle = {
  version: 1,
  request_id: ID,
  routing: {
    tenant: input.tenant,
    organization_id: input.organization_id,
    project_id: input.project_id,
    mission_id: input.mission_id,
    scope_digest: DIGEST,
  },
};
const unknown = () => ({ ok: false, status: 0, data: null });
const receipt = (status: 'created' | 'rejected' | 'unconfirmed' = 'created', id = ID) => ({
  ok: true,
  status: 200,
  data: {
    ok: true,
    request: {
      request_id: id,
      status,
      ...(status === 'created'
        ? { room_id: 'room-a' }
        : status === 'rejected'
          ? { reason: 'prerequisites_blocked' }
          : {}),
    },
    ...(status === 'created' ? { room: { id: 'room-a' } } : {}),
  },
});
function storageFixture() {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(
  storage = storageFixture(),
  overrides: Partial<Parameters<typeof createDiscussionRecoveryController>[0]> = {}
) {
  const context = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, data: { ok: true, routing: handle.routing } });
  const post = vi.fn().mockResolvedValue(unknown());
  const lookup = vi.fn().mockResolvedValue(unknown());
  const changed = vi.fn();
  const controller = createDiscussionRecoveryController({
    storage: () => storage,
    uuid: () => ID,
    context,
    post,
    lookup,
    onChange: changed,
    ...overrides,
  });
  return { storage, context, post, lookup, changed, controller };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('durable Discussion create guard (mocked storage and transport)', () => {
  it('persists only UUID and original minimal routing before the single POST', async () => {
    const f = fixture();
    f.post.mockImplementationOnce(async (body) => {
      expect(f.storage.data.get(DISCUSSION_PENDING_PREFIX + ID)).toBe(JSON.stringify(handle));
      expect(body).toMatchObject({ ...input, request_id: ID, scope_digest: DIGEST });
      return unknown();
    });
    await f.controller.start(input);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.lookup).toHaveBeenCalledTimes(1);
    expect(f.lookup.mock.calls[0][0]).toEqual(handle);
    expect([...f.storage.data.values()].join()).not.toMatch(
      /confidential source|provider|speaker|goal|locale/
    );
    expect(discussionCreationBlocked(f.controller.getState())).toBe(true);
  });
  it('blocks rapid and repeated submit synchronously without an automatic POST retry', async () => {
    const pending = deferred<ReturnType<typeof unknown>>();
    const f = fixture(undefined, { post: vi.fn(() => pending.promise) });
    const first = f.controller.start(input);
    await f.controller.start({ ...input, goal: 'second' });
    expect(f.controller.getState().phase).toBe('submitting');
    pending.resolve(unknown());
    await first;
    await f.controller.start(input);
    expect(f.lookup).toHaveBeenCalledTimes(1);
    expect(f.storage.length).toBe(1);
  });
  it.each(['scripted', 'reasoning', 'auto'] as const)(
    'blocks %s after goal, provider, mission, tenant and mode changes',
    async (speaker) => {
      const f = fixture();
      await f.controller.start(input);
      await f.controller.start({
        ...input,
        speaker,
        goal: 'different',
        provider: 'codex',
        mission_id: 'different',
        tenant: 'new-tenant',
        mode: 'dialogue',
      });
      expect(f.post).toHaveBeenCalledTimes(1);
      await f.controller.check();
      expect(f.lookup.mock.calls[1][0]).toEqual(handle);
      expect(f.post).toHaveBeenCalledTimes(1);
    }
  );
  it('reload/remount reads persisted handles and performs only original-context GET reconciliation', async () => {
    const first = fixture();
    await first.controller.start(input);
    first.controller.dispose();
    const reloaded = fixture(first.storage);
    expect(reloaded.controller.sync()).toBe(true);
    await reloaded.controller.check();
    await reloaded.controller.start({ ...input, mission_id: 'new-mission' });
    expect(reloaded.post).not.toHaveBeenCalled();
    expect(reloaded.lookup.mock.calls[0][0]).toEqual(handle);
    expect(reloaded.controller.getState().pending).toEqual([handle]);
  });
  it.each([400, 403, 404, 409, 500])(
    'HTTP %i leaves the handle unresolved, including a missing delayed POST',
    async (status) => {
      const f = fixture();
      f.post.mockResolvedValue({ ok: false, status, data: null });
      f.lookup.mockResolvedValue({ ok: false, status: 404, data: null });
      await f.controller.start(input);
      expect(f.storage.length).toBe(1);
      expect(f.controller.getState().phase).toBe('unconfirmed');
      expect(f.storage.removeItem).not.toHaveBeenCalled();
    }
  );
  it.each([
    null,
    {},
    { ok: true },
    { ok: true, room: { id: 'room-a' } },
    {
      ok: true,
      request: { request_id: OTHER, status: 'created', room_id: 'room-a' },
      room: { id: 'room-a' },
    },
    {
      ok: true,
      request: { request_id: ID, status: 'created', room_id: 'room-a' },
      room: { id: 'different' },
    },
    { ok: true, request: { request_id: ID, status: 'rejected' } },
  ])('malformed or mismatched 2xx is not proof: %j', async (data) => {
    const f = fixture();
    f.post.mockResolvedValue({ ok: true, status: 200, data });
    await f.controller.start(input);
    expect(f.storage.length).toBe(1);
    expect(discussionCreationBlocked(f.controller.getState())).toBe(true);
  });
  it.each(['created', 'rejected'] as const)(
    'only positive matching %s proof releases the guard',
    async (status) => {
      const f = fixture();
      f.post.mockResolvedValue(receipt(status));
      await f.controller.start(input);
      expect(f.storage.length).toBe(0);
      expect(f.lookup).not.toHaveBeenCalled();
      expect(f.controller.getState()).toMatchObject({
        phase: status,
        confirmedRoomId: status === 'created' ? 'room-a' : null,
      });
      expect(discussionCreationBlocked(f.controller.getState())).toBe(false);
    }
  );
  it('explicit repeated checks recover a late created receipt without POST', async () => {
    const f = fixture();
    await f.controller.start(input);
    await f.controller.check();
    f.lookup.mockResolvedValue(receipt());
    await f.controller.check();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.lookup).toHaveBeenCalledTimes(3);
    expect(f.controller.getState().confirmedRoomId).toBe('room-a');
    expect(f.storage.length).toBe(0);
  });
  it('unmount/navigation suppresses late success and retains the durable handle for reconciliation', async () => {
    const pending = deferred<ReturnType<typeof receipt>>();
    const post = vi.fn(
      (_body: DiscussionCreateInput & { request_id: string }, _signal: AbortSignal) =>
        pending.promise
    );
    const f = fixture(undefined, { post });
    const started = f.controller.start(input);
    await Promise.resolve();
    f.controller.dispose();
    expect(post.mock.calls[0][1].aborted).toBe(true);
    const calls = f.changed.mock.calls.length;
    pending.resolve(receipt());
    await started;
    expect(f.changed).toHaveBeenCalledTimes(calls);
    expect(f.storage.length).toBe(1);
    expect(f.lookup).not.toHaveBeenCalled();
    const mounted = fixture(f.storage);
    mounted.lookup.mockResolvedValue(receipt());
    await mounted.controller.check();
    expect(mounted.controller.getState().confirmedRoomId).toBe('room-a');
  });
  it.each(['read', 'write', 'getter', 'uuid'] as const)(
    'fails closed on pre-POST %s failure',
    async (failure) => {
      const storage = storageFixture();
      if (failure === 'read')
        storage.key = () => {
          throw new Error('storage denied');
        };
      if (failure === 'read')
        storage.data.set(DISCUSSION_PENDING_PREFIX + ID, JSON.stringify(handle));
      if (failure === 'write')
        storage.setItem.mockImplementation(() => {
          throw new Error('quota');
        });
      const f = fixture(storage, {
        ...(failure === 'getter'
          ? {
              storage: () => {
                throw new Error('storage denied');
              },
            }
          : {}),
        ...(failure === 'uuid'
          ? {
              uuid: () => {
                throw new Error('UUID unavailable');
              },
            }
          : {}),
      });
      await f.controller.start(input);
      expect(f.post).not.toHaveBeenCalled();
      expect(f.controller.getState().phase).toBe('storage-error');
      expect(discussionCreationBlocked(f.controller.getState())).toBe(true);
    }
  );
  it('fails closed when setItem succeeds without durable readback', async () => {
    const f = fixture();
    f.storage.setItem.mockImplementation(() => undefined);
    await f.controller.start(input);
    expect(f.post).not.toHaveBeenCalled();
    expect(f.controller.getState().phase).toBe('storage-error');
  });
  it('a corrupt persisted marker is never silently deleted or overwritten', async () => {
    const f = fixture();
    f.storage.data.set(DISCUSSION_PENDING_PREFIX + ID, '{');
    await f.controller.start(input);
    await f.controller.check();
    expect(f.post).not.toHaveBeenCalled();
    expect(f.storage.removeItem).not.toHaveBeenCalled();
    expect(f.storage.data.get(DISCUSSION_PENDING_PREFIX + ID)).toBe('{');
  });
  it('failed removal after proof remains blocked until exact proof can be reconciled', async () => {
    const f = fixture();
    f.post.mockResolvedValue(receipt());
    f.storage.removeItem.mockImplementationOnce(() => {
      throw new Error('denied');
    });
    await f.controller.start(input);
    expect(f.controller.getState().phase).toBe('storage-error');
    expect(f.storage.length).toBe(1);
    f.lookup.mockResolvedValue(receipt());
    await f.controller.check();
    expect(f.storage.length).toBe(0);
  });
  it('two tabs cannot silently overwrite an existing pending marker', async () => {
    const f = fixture();
    await f.controller.start(input);
    const second = fixture(f.storage, { uuid: () => OTHER });
    await second.controller.start({ ...input, tenant: 'different' });
    expect(second.post).not.toHaveBeenCalled();
    expect(f.storage.data.get(DISCUSSION_PENDING_PREFIX + ID)).toBe(JSON.stringify(handle));
  });
  it('storage-event sync retains other-tab markers and matching proof clears only its own', async () => {
    const f = fixture();
    await f.controller.start(input);
    const other = {
      ...handle,
      request_id: OTHER,
      routing: { tenant: 'other', scope_digest: DIGEST },
    };
    f.storage.data.set(DISCUSSION_PENDING_PREFIX + OTHER, JSON.stringify(other));
    f.controller.sync();
    expect(f.controller.getState().pending).toHaveLength(2);
    f.lookup.mockResolvedValue(receipt());
    await f.controller.check();
    expect(f.storage.data.has(DISCUSSION_PENDING_PREFIX + OTHER)).toBe(true);
    expect(discussionCreationBlocked(f.controller.getState())).toBe(true);
  });
  it('arbitrary marker deletion does not release an already known unresolved handle', async () => {
    const f = fixture();
    await f.controller.start(input);
    f.storage.data.clear();
    f.controller.sync();
    await f.controller.start(input);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.controller.getState().pending).toEqual([handle]);
  });
  it('a matching ID with altered routing cannot be removed on stale proof', async () => {
    const pending = deferred<ReturnType<typeof receipt>>();
    const f = fixture(undefined, { post: () => pending.promise });
    const started = f.controller.start(input);
    await Promise.resolve();
    f.storage.data.set(
      DISCUSSION_PENDING_PREFIX + ID,
      JSON.stringify({ ...handle, routing: { tenant: 'altered', scope_digest: DIGEST } })
    );
    pending.resolve(receipt());
    await started;
    expect(f.controller.getState().phase).toBe('storage-error');
    expect(f.storage.removeItem).not.toHaveBeenCalled();
  });
});

describe('bounded create/recovery HTTP client', () => {
  it.each(['POST', 'GET'])(
    'one deadline includes a stalled %s body and ignores its late receipt',
    async (method) => {
      vi.useFakeTimers();
      const body = deferred<unknown>();
      const fetcher = vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: () => body.promise });
      vi.stubGlobal('fetch', fetcher);
      const pending =
        method === 'POST'
          ? createDiscussion({ ...input, request_id: ID }, { timeoutMs: 50 })
          : fetchDiscussionRequest(handle, { timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(49);
      expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ ok: false, status: 0, data: null });
      expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
      body.resolve(receipt().data);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  );
  it('bounds a stalled network request without depending on fetch honoring AbortSignal', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined))
    );
    const pending = createDiscussion({ ...input, request_id: ID }, { timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    expect((await pending).ok).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reconciliation transmits only the original whitelisted routing query and no body', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(receipt().data));
    vi.stubGlobal('fetch', fetcher);
    await fetchDiscussionRequest({
      ...handle,
      routing: { ...handle.routing, goal: 'private', provider: 'claude' },
    } as DiscussionCreateHandle);
    const [url, init] = fetcher.mock.calls[0];
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.pathname).toBe('/api/discussions/requests/' + ID);
    expect(Object.fromEntries(parsed.searchParams)).toEqual(handle.routing);
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.cache).toBe('no-store');
  });
  it('empty/malformed JSON 2xx and generic non-2xx cannot establish proof', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(Response.json({ error: 'conflict' }, { status: 409 }));
    vi.stubGlobal('fetch', fetcher);
    expect(
      discussionRequestProof(handle, await createDiscussion({ ...input, request_id: ID }))
    ).toBeNull();
    expect(discussionRequestProof(handle, await fetchDiscussionRequest(handle))).toBeNull();
  });
  it('unmount abort bounds even a stalled body and does not leave a deadline timer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => undefined) })
    );
    const abort = new AbortController();
    const pending = createDiscussion({ ...input, request_id: ID }, { signal: abort.signal });
    await Promise.resolve();
    abort.abort();
    expect((await pending).ok).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('pre-submit canonical context without goal transmission', () => {
  it.each([
    { ok: false, status: 403, data: null },
    { ok: false, status: 404, data: null },
    { ok: true, status: 200, data: { ok: true, routing: {} } },
    { ok: true, status: 200, data: { ok: true, routing: { tenant: '' } } },
    { ok: true, status: 200, data: { ok: true, routing: { tenant: 't', goal: 'secret' } } },
  ])('failed or malformed context creates no UUID, marker, or POST: %j', async (response) => {
    const uuid = vi.fn(() => ID);
    const f = fixture(undefined, { uuid });
    f.context.mockResolvedValue(response);
    await f.controller.start({ ...input, tenant: undefined });
    expect(uuid).not.toHaveBeenCalled();
    expect(f.storage.length).toBe(0);
    expect(f.post).not.toHaveBeenCalled();
    expect(f.lookup).not.toHaveBeenCalled();
    expect(f.controller.getState().phase).toBe('context-error');
  });
  it('resolves a no-mission/no-tenant input into frozen canonical routing for persistence and POST', async () => {
    const f = fixture();
    f.context.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true, routing: { tenant: 'canonical-tenant', scope_digest: DIGEST } },
    });
    await f.controller.start({
      ...input,
      tenant: undefined,
      organization_id: undefined,
      project_id: undefined,
      mission_id: undefined,
    });
    expect(f.context.mock.calls[0][0]).toEqual({});
    expect(JSON.parse(f.storage.data.get(DISCUSSION_PENDING_PREFIX + ID)!)).toEqual({
      version: 1,
      request_id: ID,
      routing: { tenant: 'canonical-tenant', scope_digest: DIGEST },
    });
    expect(f.post.mock.calls[0][0]).toMatchObject({
      goal: input.goal,
      tenant: 'canonical-tenant',
      request_id: ID,
    });
    expect(f.lookup.mock.calls[0][0].routing).toEqual({
      tenant: 'canonical-tenant',
      scope_digest: DIGEST,
    });
  });
  it('freezes the goal/config snapshot and ignores changed caller fields while context is pending', async () => {
    const pending = deferred<{ ok: boolean; status: number; data: unknown }>();
    const context = vi.fn((_routing, _signal) => pending.promise);
    const f = fixture(undefined, { context });
    const mutable = { ...input };
    const started = f.controller.start(mutable);
    mutable.goal = 'changed goal';
    mutable.provider = 'codex';
    mutable.mission_id = 'changed';
    await f.controller.start(mutable);
    expect(context).toHaveBeenCalledTimes(1);
    expect(context.mock.calls[0][0]).toEqual({
      tenant: input.tenant,
      organization_id: input.organization_id,
      project_id: input.project_id,
      mission_id: input.mission_id,
    });
    expect(f.storage.length).toBe(0);
    pending.resolve({
      ok: true,
      status: 200,
      data: { ok: true, routing: { tenant: 'canonical', scope_digest: DIGEST } },
    });
    await started;
    expect(f.post.mock.calls[0][0]).toMatchObject({
      goal: input.goal,
      provider: 'claude',
      tenant: 'canonical',
    });
    expect(f.post.mock.calls[0][0]).not.toHaveProperty('mission_id');
    expect(f.post.mock.calls[0][0]).not.toHaveProperty('organization_id');
  });
  it('unmount before a late context response aborts and never persists or POSTs', async () => {
    const pending = deferred<{ ok: boolean; status: number; data: unknown }>();
    const context = vi.fn((_routing, _signal) => pending.promise);
    const f = fixture(undefined, { context });
    const started = f.controller.start(input);
    f.controller.dispose();
    expect(context.mock.calls[0][1].aborted).toBe(true);
    const calls = f.changed.mock.calls.length;
    pending.resolve({ ok: true, status: 200, data: { ok: true, routing: handle.routing } });
    await started;
    expect(f.storage.length).toBe(0);
    expect(f.post).not.toHaveBeenCalled();
    expect(f.changed).toHaveBeenCalledTimes(calls);
  });
  it.each([
    { goal: ' ' },
    { goal: 'x'.repeat(2001) },
    { locale: 'bad' },
    { speaker: 'bad' },
    { provider: undefined },
    { single_pass: true, mode: 'dialogue' },
    { max_rounds: 9 },
    { max_provider_calls: 0 },
    { provider_timeout_ms: 999 },
    { turn_delay_ms: 10001 },
    { turn_delay_ms: 0.5 },
    { single_pass: 'yes' },
  ])('invalid local input never reaches context or storage: %j', async (patch) => {
    const f = fixture();
    await f.controller.start({ ...input, ...patch } as DiscussionCreateInput);
    expect(f.context).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
    expect(f.storage.length).toBe(0);
    expect(f.controller.getState().phase).toBe('invalid-input');
  });
  it('rechecks competing markers after context, before persisting or submitting', async () => {
    const pending = deferred<{ ok: boolean; status: number; data: unknown }>();
    const f = fixture(undefined, { context: () => pending.promise });
    const started = f.controller.start(input);
    f.storage.data.set(
      DISCUSSION_PENDING_PREFIX + OTHER,
      JSON.stringify({ ...handle, request_id: OTHER })
    );
    pending.resolve({ ok: true, status: 200, data: { ok: true, routing: handle.routing } });
    await started;
    expect(f.post).not.toHaveBeenCalled();
    expect(f.storage.length).toBe(1);
    expect(discussionCreationBlocked(f.controller.getState())).toBe(true);
  });
  it('checks a selected second handle even while the first remains permanently unknown', async () => {
    const f = fixture();
    f.storage.data.set(DISCUSSION_PENDING_PREFIX + ID, JSON.stringify(handle));
    f.storage.data.set(
      DISCUSSION_PENDING_PREFIX + OTHER,
      JSON.stringify({ ...handle, request_id: OTHER })
    );
    await f.controller.check(ID);
    expect(f.controller.getState().pending).toHaveLength(2);
    f.lookup.mockResolvedValue(receipt('created', OTHER));
    await f.controller.check(OTHER);
    expect(f.lookup.mock.calls[1][0].request_id).toBe(OTHER);
    expect(f.controller.getState().confirmedRoomId).toBe('room-a');
    expect(f.controller.getState().pending).toEqual([handle]);
    expect(discussionCreationBlocked(f.controller.getState())).toBe(true);
    expect(f.post).not.toHaveBeenCalled();
  });
  it('request-context is metadata-only and bounds stalled body parsing before any creation', async () => {
    vi.useFakeTimers();
    const body = deferred<unknown>();
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => body.promise });
    vi.stubGlobal('fetch', fetcher);
    const pending = fetchDiscussionRequestContext(handle.routing, { timeoutMs: 20 });
    const [url, init] = fetcher.mock.calls[0];
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.pathname).toBe('/api/discussions/request-context');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      tenant: input.tenant,
      organization_id: input.organization_id,
      project_id: input.project_id,
      mission_id: input.mission_id,
    });
    expect(parsed.searchParams.has('scope_digest')).toBe(false);
    expect(init.body).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    expect((await pending).ok).toBe(false);
    body.resolve({ ok: true, routing: handle.routing });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it.each([undefined, 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)])(
  'rejects missing or malformed canonical scope digest before any marker: %s',
  async (scope_digest) => {
    const f = fixture();
    f.context.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true, routing: { tenant: 'canonical', scope_digest } },
    });
    await f.controller.start(input);
    expect(f.storage.length).toBe(0);
    expect(f.post).not.toHaveBeenCalled();
    expect(f.controller.getState().phase).toBe('context-error');
  }
);
it('uses only the context-returned scope digest as an unchanged selector, never a caller override', async () => {
  const f = fixture();
  await f.controller.start({ ...input, scope_digest: 'b'.repeat(64) });
  expect(f.context.mock.calls[0][0]).not.toHaveProperty('scope_digest');
  expect(f.post.mock.calls[0][0].scope_digest).toBe(DIGEST);
  expect(f.lookup.mock.calls[0][0].routing.scope_digest).toBe(DIGEST);
  expect(JSON.parse(f.storage.data.get(DISCUSSION_PENDING_PREFIX + ID)!).routing.scope_digest).toBe(
    DIGEST
  );
});
it('fails closed when a persisted scope digest is missing instead of selecting a current scope', async () => {
  const f = fixture();
  f.storage.data.set(
    DISCUSSION_PENDING_PREFIX + ID,
    JSON.stringify({ ...handle, routing: { tenant: 'original' } })
  );
  await f.controller.check();
  await f.controller.start(input);
  expect(f.lookup).not.toHaveBeenCalled();
  expect(f.post).not.toHaveBeenCalled();
  expect(f.storage.removeItem).not.toHaveBeenCalled();
  expect(f.controller.getState().phase).toBe('storage-error');
});

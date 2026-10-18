import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscussionReadinessReport } from '@agent/core/discussion/discussion-readiness';
import { fetchDiscussionReadiness } from './discussion-client';
import {
  canAttemptDiscussion,
  createDiscussionReadinessController,
  parseDiscussionReadinessReport,
  type DiscussionReadinessState,
  type ReadinessFetchResult,
  type ReadinessProvider,
} from './discussion-readiness-state';

function report(provider: ReadinessProvider = 'claude'): DiscussionReadinessReport {
  return {
    provider,
    checked_at: '2026-10-18T12:00:00.000Z',
    execution: 'unverified',
    provider_calls: 0,
    checks: [
      { id: 'scope', status: 'checked', code: 'scope_checked' },
      { id: 'adapter', status: 'checked', code: 'adapter_declared' },
      { id: 'egress_policy', status: 'checked', code: 'egress_allowed' },
      provider === 'claude'
        ? { id: 'executable', status: 'unverified', code: 'executable_unverified' }
        : { id: 'executable', status: 'checked', code: 'executable_present' },
      { id: 'artifact_destination', status: 'checked', code: 'artifact_parent_inspected' },
      { id: 'live_execution', status: 'unverified', code: 'live_execution_unverified' },
    ],
  };
}
function state(value = report()): DiscussionReadinessState {
  return {
    phase: 'checked',
    selection: { provider: value.provider, missionId: 'mission-a' },
    report: value,
  };
}
function deferred() {
  let resolve!: (value: ReadinessFetchResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<ReadinessFetchResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const response = (provider: ReadinessProvider = 'claude'): ReadinessFetchResult => ({
  ok: true,
  status: 200,
  data: { readiness: report(provider) },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('readiness response validation and launch gate', () => {
  it('accepts static checks without promoting unverified execution into readiness', () => {
    expect(parseDiscussionReadinessReport(report(), 'claude')).toEqual(report());
    expect(canAttemptDiscussion('brief', 'claude', 'mission-a', state())).toBe(true);
    expect(state().report?.execution).toBe('unverified');
  });
  it.each([
    null,
    {},
    { ...report(), provider: 'codex' },
    { ...report(), execution: 'confirmed' },
    { ...report(), provider_calls: 1 },
    { ...report(), checked_at: 'not a date' },
    { ...report(), checks: [] },
    { ...report(), checks: report().checks.slice(1) },
    { ...report(), checks: [...report().checks.slice(0, 5), report().checks[0]] },
    {
      ...report(),
      checks: report().checks.map((check, index) =>
        index ? check : { ...check, code: 'unknown' }
      ),
    },
    {
      ...report(),
      checks: report().checks.map((check, index) =>
        index ? check : { ...check, status: 'unverified' }
      ),
    },
    {
      ...report(),
      checks: report().checks.map((check, index) => (index ? check : { ...check, id: 'adapter' })),
    },
  ])('rejects an incomplete or contradictory report: %#', (value) => {
    expect(parseDiscussionReadinessReport(value, 'claude')).toBeNull();
    expect(
      canAttemptDiscussion('brief', 'claude', 'mission-a', {
        ...state(),
        report: value as DiscussionReadinessReport,
      })
    ).toBe(false);
  });
  it('strips unrecognized fields instead of exposing raw server metadata', () => {
    expect(
      JSON.stringify(
        parseDiscussionReadinessReport(
          { ...report(), error: '/private/secret', token: 'secret' },
          'claude'
        )
      )
    ).not.toContain('secret');
  });
  it.each(['idle', 'checking', 'failed'] as const)('disables real brief launch in %s', (phase) => {
    expect(canAttemptDiscussion('brief', 'claude', 'mission-a', { ...state(), phase })).toBe(false);
  });
  it('binds a check to both provider and mission', () => {
    expect(canAttemptDiscussion('brief', 'codex', 'mission-a', state())).toBe(false);
    expect(canAttemptDiscussion('brief', 'claude', 'mission-b', state())).toBe(false);
    expect(canAttemptDiscussion('brief', 'claude', '', state())).toBe(false);
  });
  it.each([
    ['scope', 'tenant_required'],
    ['adapter', 'adapter_unavailable'],
    ['egress_policy', 'egress_denied'],
    ['executable', 'executable_missing'],
    ['artifact_destination', 'artifact_unavailable'],
  ] as const)('blocks launch for %s', (id, code) => {
    const provider = id === 'executable' ? 'codex' : 'claude';
    const value = report(provider);
    value.checks = value.checks.map((check) =>
      check.id === id ? { id, status: 'blocked', code } : check
    );
    if (id === 'scope' || id === 'adapter')
      value.checks[2] = { id: 'egress_policy', status: 'unverified', code: 'egress_unverified' };
    expect(parseDiscussionReadinessReport(value, provider)).not.toBeNull();
    expect(canAttemptDiscussion('brief', provider, 'mission-a', state(value))).toBe(false);
  });
  it.each([
    ['claude', 'executable_unverified'],
    ['codex', 'executable_inspection_unavailable'],
  ] as const)('permits an explicit attempt for %s with %s', (provider, code) => {
    const value = report(provider);
    value.checks[3] = { id: 'executable', status: 'unverified', code };
    expect(canAttemptDiscussion('brief', provider, 'mission-a', state(value))).toBe(true);
  });
  it('rejects unverified egress without a blocked prerequisite', () => {
    const value = report();
    value.checks[2] = { id: 'egress_policy', status: 'unverified', code: 'egress_unverified' };
    expect(parseDiscussionReadinessReport(value, 'claude')).toBeNull();
    expect(canAttemptDiscussion('brief', 'claude', 'mission-a', state(value))).toBe(false);
  });
  it('rejects inspected egress with a blocked prerequisite', () => {
    const value = report();
    value.checks[0] = { id: 'scope', status: 'blocked', code: 'tenant_required' };
    expect(parseDiscussionReadinessReport(value, 'claude')).toBeNull();
    value.checks[2] = { id: 'egress_policy', status: 'unverified', code: 'egress_unverified' };
    expect(parseDiscussionReadinessReport(value, 'claude')).toEqual(value);
    expect(canAttemptDiscussion('brief', 'claude', 'mission-a', state(value))).toBe(false);
  });
  it.each([
    ['claude', 'executable_present', 'checked'],
    ['claude', 'executable_missing', 'blocked'],
    ['claude', 'executable_inspection_unavailable', 'unverified'],
    ['codex', 'executable_unverified', 'unverified'],
  ] as const)(
    'rejects a provider-specific executable contradiction: %s %s',
    (provider, code, status) => {
      const value = report(provider);
      value.checks[3] = { id: 'executable', status, code };
      expect(parseDiscussionReadinessReport(value, provider)).toBeNull();
      expect(canAttemptDiscussion('brief', provider, 'mission-a', state(value))).toBe(false);
    }
  );
  it('keeps scripted, panel and dialogue launch behavior independent of the new check', () => {
    const pending: DiscussionReadinessState = { phase: 'checking', selection: null, report: null };
    expect(canAttemptDiscussion('brief', 'scripted', '', pending)).toBe(true);
    for (const format of ['panel', 'dialogue'] as const) {
      for (const engine of ['scripted', 'claude', 'codex'] as const) {
        expect(canAttemptDiscussion(format, engine, '', pending)).toBe(true);
      }
    }
  });
});

describe('readiness request controller (async state tests, not a browser)', () => {
  it('deduplicates repeated checks and only reports data, without starting generation', async () => {
    const request = deferred();
    const fetcher = vi.fn(() => request.promise);
    const changed = vi.fn();
    const controller = createDiscussionReadinessController(fetcher, changed);
    const selected = { provider: 'claude' as const, missionId: 'mission-a' };
    const first = controller.check(selected);
    expect(controller.getState().phase).toBe('checking');
    expect(controller.check({ ...selected })).toBe(first);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    request.resolve(response());
    await first;
    expect(controller.getState().phase).toBe('checked');
    expect(changed).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['provider', 'mission'] as const)(
    'ignores a stale response after a %s change',
    async (change) => {
      const old = deferred();
      const current = deferred();
      const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
      const changed = vi.fn();
      const controller = createDiscussionReadinessController(fetcher, changed);
      const first = controller.check({ provider: 'claude', missionId: 'mission-a' });
      await Promise.resolve();
      const selected = {
        provider: change === 'provider' ? ('codex' as const) : ('claude' as const),
        missionId: change === 'mission' ? 'mission-b' : 'mission-a',
      };
      const second = controller.check(selected);
      await Promise.resolve();
      expect(fetcher.mock.calls[0][1].aborted).toBe(true);
      current.resolve(response(selected.provider));
      await second;
      const calls = changed.mock.calls.length;
      old.resolve(response());
      await first;
      expect(changed).toHaveBeenCalledTimes(calls);
      expect(controller.getState().selection).toEqual(selected);
      expect(controller.getState().report?.provider).toBe(selected.provider);
    }
  );
  it('invalidates an old same-selection response after cancellation and refresh', async () => {
    const old = deferred();
    const current = deferred();
    const controller = createDiscussionReadinessController(
      vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise),
      vi.fn()
    );
    const selected = { provider: 'claude' as const, missionId: '' };
    const first = controller.check(selected);
    await Promise.resolve();
    controller.cancel();
    const second = controller.check(selected);
    await Promise.resolve();
    current.resolve({ ok: false, status: 403, data: null });
    await second;
    old.resolve(response());
    await first;
    expect(controller.getState()).toMatchObject({
      phase: 'failed',
      failure: 'access',
      report: null,
    });
  });
  it('ignores results after unmount cleanup even when the fetcher ignores abort', async () => {
    const request = deferred();
    const changed = vi.fn();
    const controller = createDiscussionReadinessController(() => request.promise, changed);
    const pending = controller.check({ provider: 'claude', missionId: '' });
    await Promise.resolve();
    controller.cancel();
    request.resolve(response());
    await pending;
    expect(changed).toHaveBeenCalledTimes(1);
    expect(controller.getState().phase).toBe('idle');
  });
  it('does not issue a request canceled before its asynchronous start', async () => {
    const fetcher = vi.fn();
    const controller = createDiscussionReadinessController(fetcher, vi.fn());
    const pending = controller.check({ provider: 'claude', missionId: '' });
    controller.cancel();
    await pending;
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [401, 'access'],
    [403, 'access'],
    [404, 'mission'],
    [409, 'unavailable'],
  ] as const)('maps HTTP %s to safe %s guidance', async (status, failure) => {
    const controller = createDiscussionReadinessController(
      async () => ({ ok: false, status, data: null }),
      vi.fn()
    );
    await controller.check({ provider: 'claude', missionId: 'missing-mission' });
    expect(controller.getState()).toMatchObject({ phase: 'failed', failure, report: null });
  });
  it('fails closed on a mismatched provider and permits a later explicit retry', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response('codex'))
      .mockResolvedValueOnce(response());
    const controller = createDiscussionReadinessController(fetcher, vi.fn());
    const selected = { provider: 'claude' as const, missionId: '' };
    await controller.check(selected);
    expect(controller.getState()).toMatchObject({
      phase: 'failed',
      failure: 'invalid',
      report: null,
    });
    await controller.check(selected);
    expect(controller.getState().phase).toBe('checked');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('invalidates an inspected report after create denial and requires an explicit current check', async () => {
    const blocked = report();
    blocked.checks[2] = { id: 'egress_policy', status: 'blocked', code: 'egress_denied' };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce({ ok: true, status: 200, data: { readiness: blocked } });
    const controller = createDiscussionReadinessController(fetcher, vi.fn());
    const selected = { provider: 'claude' as const, missionId: 'mission-a' };
    await controller.check(selected);
    expect(canAttemptDiscussion('brief', 'claude', 'mission-a', controller.getState())).toBe(true);
    // Launcher applies this transition after a rejected real-brief POST, including 409.
    controller.invalidate(selected);
    expect(controller.getState()).toMatchObject({
      phase: 'failed',
      selection: selected,
      report: null,
    });
    expect(canAttemptDiscussion('brief', 'claude', 'mission-a', controller.getState())).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await controller.check(selected);
    expect(controller.getState().report?.checks).toContainEqual({
      id: 'egress_policy',
      status: 'blocked',
      code: 'egress_denied',
    });
    expect(canAttemptDiscussion('brief', 'claude', 'mission-a', controller.getState())).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('invalidates and ignores any outstanding response after a create access rejection', async () => {
    const request = deferred();
    const changed = vi.fn();
    const controller = createDiscussionReadinessController(() => request.promise, changed);
    const selected = { provider: 'claude' as const, missionId: '' };
    const pending = controller.check(selected);
    await Promise.resolve();
    controller.invalidate(selected, 'access');
    const calls = changed.mock.calls.length;
    request.resolve(response());
    await pending;
    expect(changed).toHaveBeenCalledTimes(calls);
    expect(controller.getState()).toMatchObject({
      phase: 'failed',
      failure: 'access',
      report: null,
    });
  });
  it('discards previous approval immediately on retry and suppresses raw errors', async () => {
    const request = deferred();
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockReturnValueOnce(request.promise);
    const changed = vi.fn();
    const controller = createDiscussionReadinessController(fetcher, changed);
    const selected = { provider: 'claude' as const, missionId: 'mission-a' };
    await controller.check(selected);
    const retry = controller.check(selected);
    await Promise.resolve();
    expect(canAttemptDiscussion('brief', 'claude', 'mission-a', controller.getState())).toBe(false);
    request.reject(new Error('/private/token-secret'));
    await retry;
    expect(controller.getState()).toMatchObject({
      phase: 'failed',
      failure: 'unavailable',
      report: null,
    });
    expect(JSON.stringify(changed.mock.calls)).not.toContain('token-secret');
  });
});

describe('readiness deadline and cleanup', () => {
  it('times out a stalled fetch after 15 seconds, ignores late success and permits explicit retry', async () => {
    vi.useFakeTimers();
    const request = deferred();
    const fetcher = vi.fn().mockReturnValueOnce(request.promise).mockResolvedValueOnce(response());
    const changed = vi.fn();
    const controller = createDiscussionReadinessController(fetcher, changed);
    const selected = { provider: 'claude' as const, missionId: 'mission-a' };
    const pending = controller.check(selected);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(controller.getState().phase).toBe('checking');
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetcher.mock.calls[0][1].aborted).toBe(true);
    expect(controller.getState()).toMatchObject({
      phase: 'failed',
      failure: 'unavailable',
      report: null,
    });
    expect(canAttemptDiscussion('brief', 'claude', 'mission-a', controller.getState())).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const calls = changed.mock.calls.length;
    request.resolve(response());
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(calls);
    expect(controller.getState().phase).toBe('failed');
    await controller.check(selected);
    expect(controller.getState().phase).toBe('checked');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('ignores a late rejection after an injected deadline', async () => {
    vi.useFakeTimers();
    const request = deferred();
    const changed = vi.fn();
    const controller = createDiscussionReadinessController(() => request.promise, changed, {
      timeoutMs: 25,
    });
    const pending = controller.check({ provider: 'claude', missionId: '' });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);
    await pending;
    const calls = changed.mock.calls.length;
    request.reject(new Error('/private/timeout-secret'));
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(calls);
    expect(JSON.stringify(changed.mock.calls)).not.toContain('timeout-secret');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('also bounds stalled response-body parsing and ignores its late result', async () => {
    vi.useFakeTimers();
    let finishBody!: (value: unknown) => void;
    const body = new Promise<unknown>((resolve) => {
      finishBody = resolve;
    });
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => body });
    vi.stubGlobal('fetch', fetcher);
    const changed = vi.fn();
    const controller = createDiscussionReadinessController(
      ({ provider, missionId }, signal) => fetchDiscussionReadiness(provider, missionId, signal),
      changed,
      { timeoutMs: 30 }
    );
    const pending = controller.check({ provider: 'claude', missionId: '' });
    await vi.advanceTimersByTimeAsync(30);
    await pending;
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    const calls = changed.mock.calls.length;
    finishBody({ ok: true, readiness: report() });
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenCalledTimes(calls);
    expect(controller.getState().phase).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['success', 'failure', 'rejection', 'cancel'] as const)(
    'clears its timer after %s',
    async (outcome) => {
      vi.useFakeTimers();
      const request = deferred();
      const changed = vi.fn();
      const controller = createDiscussionReadinessController(() => request.promise, changed);
      const pending = controller.check({ provider: 'claude', missionId: '' });
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1);
      if (outcome === 'success') request.resolve(response());
      else if (outcome === 'failure') request.resolve({ ok: false, status: 500, data: null });
      else if (outcome === 'rejection') request.reject(new Error('fixture'));
      else controller.cancel();
      await pending;
      expect(vi.getTimerCount()).toBe(0);
      const calls = changed.mock.calls.length;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(changed).toHaveBeenCalledTimes(calls);
    }
  );
});

describe('readiness HTTP request contract', () => {
  it('sends only provider and optional mission, with no goal or body', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ ok: true, readiness: report('codex') }));
    vi.stubGlobal('fetch', fetcher);
    const abort = new AbortController();
    await fetchDiscussionReadiness('codex', 'mission / & one', abort.signal);
    const [url, init] = fetcher.mock.calls[0];
    const params = new URL(url, 'http://localhost').searchParams;
    expect([...params.keys()]).toEqual(['provider', 'mission_id']);
    expect(params.get('provider')).toBe('codex');
    expect(params.get('mission_id')).toBe('mission / & one');
    expect(init.body).toBeUndefined();
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.signal).toBe(abort.signal);
    expect(init.cache).toBe('no-store');
    await fetchDiscussionReadiness('claude', '');
    expect(fetcher.mock.calls[1][0]).toBe('/api/discussions/readiness?provider=claude');
  });
});

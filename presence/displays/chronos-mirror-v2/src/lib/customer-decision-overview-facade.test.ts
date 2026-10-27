import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExecResultAsync: vi.fn(),
  safeExistsSync: vi.fn(() => true),
  warn: vi.fn(),
}));

vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  safeExecResultAsync: mocks.safeExecResultAsync,
  safeExistsSync: mocks.safeExistsSync,
}));
vi.mock('@agent/core/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/core')>();
  return { ...actual, logger: { ...actual.logger, warn: mocks.warn } };
});

import {
  createConcurrencyLimit,
  createFacadeReader,
  facadeArgs,
  FACADE_CHILD_CONCURRENCY,
  OVERVIEW_CHILD_CLEARED_ENV,
  OVERVIEW_ERRORS,
  OVERVIEW_FACADE_SCRIPT,
  overviewChildEnv,
  readFacadeView,
  runOverviewChild,
  type OverviewChildOutcome,
} from './customer-decision-overview-facade';
import {
  buildCustomerDecisionCaseDetail,
  buildCustomerDecisionOverview,
  emptyLearningView,
} from '@agent/core/customer-decision';

const NOW = '2026-10-25T00:00:00.000Z';

/** An empty overview from the real contract builder. */
const minimalOverview = (tenant: string) =>
  buildCustomerDecisionOverview({ tenant_slug: tenant, cases: [], case_failures: [], now: NOW });

const minimalCase = (tenant: string, caseId = 'case-a') =>
  buildCustomerDecisionCaseDetail({
    tenant_slug: tenant,
    case_id: caseId,
    agendas: [],
    ledger: [],
    receipts: [],
    invites: [],
    consumers: [],
    now: NOW,
  });

const ok = (value: unknown): OverviewChildOutcome => ({
  status: 0,
  stdout: `${JSON.stringify(value)}\n`,
  stderr: '',
  aborted: false,
});

const failed = (stderr: string): OverviewChildOutcome => ({
  status: 2,
  stdout: '',
  stderr,
  aborted: false,
});

describe('customer-decision facade child (CD-12)', () => {
  beforeEach(() => {
    mocks.safeExecResultAsync.mockReset();
    mocks.safeExistsSync.mockReset();
    mocks.safeExistsSync.mockReturnValue(true);
    mocks.warn.mockReset();
  });

  it('binds the child to the tenant with no system role, persona, sudo or mission', () => {
    const env = overviewChildEnv('acme');
    expect(env).toMatchObject({ KYBERION_TENANT: 'acme', SYSTEM_ROLE: '' });
    for (const key of OVERVIEW_CHILD_CLEARED_ENV) expect(env[key]).toBe('');
    expect(Object.keys(env).sort()).toEqual(
      [...OVERVIEW_CHILD_CLEARED_ENV, 'SYSTEM_ROLE', 'KYBERION_TENANT', 'KYBERION_ROOT']
        .filter((key) => key !== 'KYBERION_ROOT' || env.KYBERION_ROOT !== undefined)
        .sort()
    );
  });

  it('has a fixed argv per view kind', () => {
    expect(facadeArgs('overview', 'acme')).toEqual([
      'overview',
      '--tenant',
      'acme',
      '--summary',
      '--json',
    ]);
    expect(facadeArgs('case', 'acme', 'case-a')).toEqual([
      'overview',
      '--tenant',
      'acme',
      '--case',
      'case-a',
      '--detail',
      '--json',
    ]);
    expect(facadeArgs('learning', 'acme')).toEqual([
      'overview',
      '--tenant',
      'acme',
      '--learning',
      '--json',
    ]);
    expect(facadeArgs('learning', 'acme', '2026-10-19')).toEqual([
      'overview',
      '--tenant',
      'acme',
      '--learning',
      '--date',
      '2026-10-19',
      '--json',
    ]);
  });

  it.each([
    ['case', undefined],
    ['case', '--json'],
    ['case', '../x'],
    ['learning', '--date'],
    ['learning', '2026-10-19 --x'],
  ] as const)('never builds an argv for %s with %s', (kind, arg) => {
    expect(() => facadeArgs(kind, 'acme', arg)).toThrow();
  });

  it('runs the built facade with the given argv, a timeout and an output cap', async () => {
    mocks.safeExecResultAsync.mockResolvedValue({ status: 0, stdout: '{}', stderr: '' });
    await runOverviewChild('acme', facadeArgs('case', 'acme', 'case-a'));
    const [command, args, options] = mocks.safeExecResultAsync.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(String(args[0]).endsWith(OVERVIEW_FACADE_SCRIPT)).toBe(true);
    expect(args.slice(1)).toEqual(facadeArgs('case', 'acme', 'case-a'));
    expect(options.env).toEqual(overviewChildEnv('acme'));
    expect(options.env.SYSTEM_ROLE).toBe('');
    expect(options.env).not.toHaveProperty('PATH');
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.maxOutputMB).toBeGreaterThan(0);
    expect(options).not.toHaveProperty('input');
  });

  it('marks a killed child as aborted', async () => {
    mocks.safeExecResultAsync.mockResolvedValue({ status: null, stdout: '', stderr: '' });
    expect((await runOverviewChild('acme', facadeArgs('overview', 'acme'))).aborted).toBe(true);
  });

  it('returns the validated view of the bound tenant for each kind', async () => {
    expect(
      await readFacadeView('overview', 'acme', undefined, async () => ok(minimalOverview('acme')))
    ).toMatchObject({ ok: true, value: { tenant_slug: 'acme' } });
    expect(
      await readFacadeView('case', 'acme', 'case-a', async () => ok(minimalCase('acme')))
    ).toMatchObject({ ok: true, value: { tenant_slug: 'acme', case_id: 'case-a' } });
    expect(
      await readFacadeView('learning', 'acme', undefined, async () => ok(emptyLearningView('acme')))
    ).toMatchObject({ ok: true, value: { tenant_slug: 'acme', report_date: null } });
  });

  it.each([
    ['another case', 'case', 'case-a', () => ok(minimalCase('acme', 'case-b'))],
    ['another tenant', 'case', 'case-a', () => ok(minimalCase('globex'))],
    [
      'another report date',
      'learning',
      '2026-10-19',
      () => ok({ ...emptyLearningView('acme'), report_date: '2026-10-12' }),
    ],
    ['an overview for a case', 'case', 'case-a', () => ok(minimalOverview('acme'))],
  ] as const)('refuses %s (502, invalid)', async (_label, kind, arg, run) => {
    expect(await readFacadeView(kind, 'acme', arg, async () => run())).toEqual({
      ok: false,
      status: 502,
      error: OVERVIEW_ERRORS.invalid,
    });
  });

  it.each([
    ['case', 'case-a', 'CUSTOMER_DECISION_CASE_NOT_FOUND', OVERVIEW_ERRORS.case_not_found],
    [
      'learning',
      '2026-10-19',
      'CUSTOMER_DECISION_REPORT_NOT_FOUND',
      OVERVIEW_ERRORS.report_not_found,
    ],
  ] as const)('maps the %s not-found code to 404', async (kind, arg, code, error) => {
    const result = await readFacadeView(kind, 'acme', arg, async () =>
      failed(`[${code}] /Users/x/knowledge/confidential/acme secret`)
    );
    expect(result).toEqual({ ok: false, status: 404, error });
    expect(JSON.stringify(result)).not.toMatch(/secret|confidential/u);
  });

  it('keeps a not-found code of another kind a failure', async () => {
    const result = await readFacadeView('overview', 'acme', undefined, async () =>
      failed('[CUSTOMER_DECISION_CASE_NOT_FOUND] x')
    );
    expect(result).toEqual({ ok: false, status: 502, error: OVERVIEW_ERRORS.failed });
  });

  it.each([
    ['not built', () => false, async () => ok({}), 503, OVERVIEW_ERRORS.not_built],
    [
      'aborted',
      () => true,
      async () => ({ status: null, stdout: '', stderr: '', aborted: true }),
      504,
      OVERVIEW_ERRORS.timed_out,
    ],
    [
      'a failed child',
      () => true,
      async () =>
        failed('[CUSTOMER_DECISION_TENANT_MISMATCH] /Users/x/knowledge/confidential/acme secret'),
      502,
      OVERVIEW_ERRORS.failed,
    ],
    [
      'a child that did not start',
      () => true,
      async () => {
        throw new Error('spawn ENOENT /secret/path');
      },
      502,
      OVERVIEW_ERRORS.failed,
    ],
    ['non-JSON output', () => true, async () => ok('nope'), 502, OVERVIEW_ERRORS.invalid],
    [
      'another version',
      () => true,
      async () => ok({ ...minimalOverview('acme'), version: '2.0.0' }),
      502,
      OVERVIEW_ERRORS.invalid,
    ],
    [
      'another tenant',
      () => true,
      async () => ok(minimalOverview('globex')),
      502,
      OVERVIEW_ERRORS.invalid,
    ],
  ] as const)('maps %s to a fixed error', async (_label, exists, run, status, error) => {
    const result = await readFacadeView('overview', 'acme', undefined, run, exists);
    expect(result).toEqual({
      ok: false,
      status,
      error,
      ...(status === 503 ? { reason: 'not_built' } : {}),
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|ENOENT|confidential/u);
  });

  it('logs only the diagnostic code of a failed child', async () => {
    await readFacadeView('overview', 'acme', undefined, async () =>
      failed('[CUSTOMER_DECISION_TENANT_MISMATCH] a secret detail')
    );
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const line = String(mocks.warn.mock.calls[0][0]);
    expect(line).toContain('CUSTOMER_DECISION_TENANT_MISMATCH');
    expect(line).not.toContain('secret');
  });

  it('caches a success per kind:tenant:arg for the TTL and shares a pending run', async () => {
    let clock = 0;
    const run = vi.fn(async (tenant: string, args: string[]) =>
      ok(args.includes('--case') ? minimalCase(tenant, args[4]) : minimalOverview(tenant))
    );
    const read = createFacadeReader({
      run,
      scriptExists: () => true,
      ttlMs: 1000,
      now: () => clock,
    });
    await Promise.all([read('overview', 'acme'), read('overview', 'acme')]);
    expect(run).toHaveBeenCalledTimes(1);
    clock = 999;
    await read('overview', 'acme');
    expect(run).toHaveBeenCalledTimes(1);
    expect(await read('overview', 'globex')).toMatchObject({
      ok: true,
      value: { tenant_slug: 'globex' },
    });
    expect(run).toHaveBeenCalledTimes(2);
    // Another kind, and another case of the same kind, are other keys.
    expect(await read('case', 'acme', 'case-a')).toMatchObject({
      ok: true,
      value: { case_id: 'case-a' },
    });
    expect(await read('case', 'acme', 'case-b')).toMatchObject({
      ok: true,
      value: { case_id: 'case-b' },
    });
    expect(run).toHaveBeenCalledTimes(4);
    clock = 2000;
    await read('overview', 'acme');
    expect(run).toHaveBeenCalledTimes(5);
  });

  it('does not cache a failure', async () => {
    const run = vi
      .fn<(tenant: string, args: string[]) => Promise<OverviewChildOutcome>>()
      .mockResolvedValueOnce(failed('[CUSTOMER_DECISION_X] x'))
      .mockResolvedValueOnce(ok(minimalCase('acme')));
    const read = createFacadeReader({ run, scriptExists: () => true, now: () => 0 });
    expect(await read('case', 'acme', 'case-a')).toMatchObject({ ok: false, status: 502 });
    await Promise.resolve();
    expect((await read('case', 'acme', 'case-a')).ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps a not-found briefly (shorter than a success)', async () => {
    let clock = 0;
    const run = vi
      .fn<(tenant: string, args: string[]) => Promise<OverviewChildOutcome>>()
      .mockResolvedValueOnce(failed('[CUSTOMER_DECISION_CASE_NOT_FOUND] x'))
      .mockResolvedValueOnce(ok(minimalCase('acme')));
    const read = createFacadeReader({
      run,
      scriptExists: () => true,
      ttlMs: 1000,
      notFoundTtlMs: 100,
      now: () => clock,
    });
    expect(await read('case', 'acme', 'case-a')).toMatchObject({ ok: false, status: 404 });
    await Promise.resolve();
    clock = 99;
    expect(await read('case', 'acme', 'case-a')).toMatchObject({ ok: false, status: 404 });
    expect(run).toHaveBeenCalledTimes(1);
    clock = 100;
    expect((await read('case', 'acme', 'case-a')).ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest settled entry first when the cache is full', async () => {
    let release: (() => void) | undefined;
    const run = vi.fn(async (tenant: string) => {
      if (tenant === 'pending') await new Promise<void>((resolve) => (release = resolve));
      return ok(minimalOverview(tenant));
    });
    const read = createFacadeReader({ run, scriptExists: () => true, cacheLimit: 2, now: () => 0 });
    const pending = read('overview', 'pending');
    await read('overview', 'settled');
    await Promise.resolve();
    // Full: 'pending' (oldest, still running) stays shared; 'settled' goes.
    await read('overview', 'third');
    await Promise.resolve();
    void read('overview', 'pending');
    expect(run.mock.calls.filter(([tenant]) => tenant === 'pending')).toHaveLength(1);
    await read('overview', 'settled');
    expect(run.mock.calls.filter(([tenant]) => tenant === 'settled')).toHaveLength(2);
    release?.();
    expect((await pending).ok).toBe(true);
  });

  it('answers a fixed 503 (busy) when the child queue is full', async () => {
    const releases: Array<() => void> = [];
    const run = vi.fn(async (tenant: string) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return ok(minimalOverview(tenant));
    });
    const read = createFacadeReader({
      run,
      scriptExists: () => true,
      concurrency: 1,
      maxWaiting: 1,
    });
    const first = read('overview', 't1');
    const second = read('overview', 't2');
    const third = await read('overview', 't3');
    expect(third).toEqual({ ok: false, status: 503, error: OVERVIEW_ERRORS.busy, reason: 'busy' });
    // A busy answer is not cached: the next request queues again.
    while (releases.length > 0 || run.mock.calls.length < 2) {
      releases.shift()?.();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    }
    expect((await first).ok && (await second).ok).toBe(true);
    const retry = read('overview', 't3');
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    releases.shift()?.();
    expect((await retry).ok).toBe(true);
  });

  it(`runs at most ${FACADE_CHILD_CONCURRENCY} children at once`, async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const run = vi.fn(async (tenant: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return ok(minimalOverview(tenant));
    });
    const read = createFacadeReader({ run, scriptExists: () => true });
    const tenants = ['t1', 't2', 't3', 't4', 't5', 't6'];
    const pending = tenants.map((tenant) => read('overview', tenant));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(FACADE_CHILD_CONCURRENCY);
    while (releases.length > 0 || run.mock.calls.length < tenants.length) {
      releases.shift()?.();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    }
    releases.forEach((release) => release());
    const results = await Promise.all(pending);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(run).toHaveBeenCalledTimes(tenants.length);
    expect(peak).toBe(FACADE_CHILD_CONCURRENCY);
  });

  it('releases a slot when a task throws', async () => {
    const limited = createConcurrencyLimit(1);
    await expect(limited(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await limited(async () => 'next')).toBe('next');
  });
});

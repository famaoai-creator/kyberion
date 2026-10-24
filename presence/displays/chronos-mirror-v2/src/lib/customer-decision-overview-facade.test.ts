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
  createOverviewReader,
  OVERVIEW_CHILD_CLEARED_ENV,
  OVERVIEW_ERRORS,
  OVERVIEW_FACADE_SCRIPT,
  overviewChildEnv,
  readTenantOverview,
  runOverviewChild,
  type OverviewChildOutcome,
} from './customer-decision-overview-facade';
import { buildCustomerDecisionOverview } from '@agent/core/customer-decision';

/** An empty overview from the real contract builder. */
const minimalOverview = (tenant: string) =>
  buildCustomerDecisionOverview({
    tenant_slug: tenant,
    cases: [],
    case_failures: [],
    now: '2026-10-25T00:00:00.000Z',
  });

const ok = (value: unknown): OverviewChildOutcome => ({
  status: 0,
  stdout: `${JSON.stringify(value)}\n`,
  stderr: '',
  aborted: false,
});

describe('customer-decision overview facade child (CD-12)', () => {
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

  it('runs the built facade overview verb for the tenant with a timeout and output cap', async () => {
    mocks.safeExecResultAsync.mockResolvedValue({ status: 0, stdout: '{}', stderr: '' });
    await runOverviewChild('acme');
    const [command, args, options] = mocks.safeExecResultAsync.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(String(args[0]).endsWith(OVERVIEW_FACADE_SCRIPT)).toBe(true);
    expect(args.slice(1)).toEqual(['overview', '--tenant', 'acme', '--json']);
    expect(options.env).toEqual(overviewChildEnv('acme'));
    expect(options.env.SYSTEM_ROLE).toBe('');
    expect(options.env).not.toHaveProperty('PATH');
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.maxOutputMB).toBeGreaterThan(0);
    expect(options).not.toHaveProperty('input');
  });

  it('marks a killed child as aborted', async () => {
    mocks.safeExecResultAsync.mockResolvedValue({ status: null, stdout: '', stderr: '' });
    expect((await runOverviewChild('acme')).aborted).toBe(true);
  });

  it('returns the validated overview of the bound tenant', async () => {
    const result = await readTenantOverview('acme', async () => ok(minimalOverview('acme')));
    expect(result).toMatchObject({ ok: true, overview: { tenant_slug: 'acme' } });
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
      async () => ({
        status: 2,
        stdout: '',
        stderr: '[CUSTOMER_DECISION_TENANT_MISMATCH] /Users/x/knowledge/confidential/acme secret',
        aborted: false,
      }),
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
    const result = await readTenantOverview('acme', run, exists);
    expect(result).toEqual({ ok: false, status, error });
    expect(JSON.stringify(result)).not.toMatch(/secret|ENOENT|confidential/u);
  });

  it('logs only the diagnostic code of a failed child', async () => {
    await readTenantOverview('acme', async () => ({
      status: 2,
      stdout: '',
      stderr: '[CUSTOMER_DECISION_TENANT_MISMATCH] a secret detail',
      aborted: false,
    }));
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const line = String(mocks.warn.mock.calls[0][0]);
    expect(line).toContain('CUSTOMER_DECISION_TENANT_MISMATCH');
    expect(line).not.toContain('secret');
  });

  it('caches a success per tenant for the TTL and shares a pending run', async () => {
    let clock = 0;
    const run = vi.fn(async (tenant: string) => ok(minimalOverview(tenant)));
    const read = createOverviewReader({
      run,
      scriptExists: () => true,
      ttlMs: 1000,
      now: () => clock,
    });
    await Promise.all([read('acme'), read('acme')]);
    expect(run).toHaveBeenCalledTimes(1);
    clock = 999;
    await read('acme');
    expect(run).toHaveBeenCalledTimes(1);
    const other = await read('globex');
    expect(other).toMatchObject({ ok: true, overview: { tenant_slug: 'globex' } });
    expect(run).toHaveBeenCalledTimes(2);
    clock = 2000;
    await read('acme');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('does not cache a failure', async () => {
    const run = vi
      .fn<(tenant: string) => Promise<OverviewChildOutcome>>()
      .mockResolvedValueOnce({ status: 1, stdout: '', stderr: '', aborted: false })
      .mockResolvedValueOnce(ok(minimalOverview('acme')));
    const read = createOverviewReader({ run, scriptExists: () => true, now: () => 0 });
    expect((await read('acme')).ok).toBe(false);
    await Promise.resolve();
    expect((await read('acme')).ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

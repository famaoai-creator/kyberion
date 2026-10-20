import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import {
  safeExistsSync,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '../secure-io.js';
import { withExecutionContextAsync } from '../authority.js';
import {
  currentResourceAccessScope,
  runInResourceAccessScope,
} from '../foundation/resource-access-scope.js';
import {
  getActiveSandboxPolicy,
  withSandboxPolicy,
  type SandboxPolicy,
} from '../shell/sandbox-policy.js';
import {
  consumeTenantBudget,
  inspectTenantBudget,
  withTenantBudget,
  TenantRateLimitExceededError,
  _resetTenantRateLimitStateForTests,
  _resetTenantRateLimitPolicyCacheForTests,
  normalizeTenantRateLimitLockRecord,
} from './tenant-rate-limiter.js';

describe('tenant-rate-limiter (IP-29)', () => {
  const lockPath = pathResolver.rootResolve(
    'active/shared/runtime/tenant-rate-limit-state.json.lock'
  );
  const externalLockPath = pathResolver.sharedTmp('tenant-rate-limit-external.lock');
  let savedTenant: string | undefined;
  let savedPersona: string | undefined;
  const readonly: SandboxPolicy = {
    mode: 'read-only',
    networkAccess: true,
    networkAllowlist: ['localhost'],
    provider: 'kyberion',
    enforcement: 'full',
    enforcement_reason: 'advisory quota regression',
  };
  const advisory = <T>(fn: () => Promise<T>) =>
    withExecutionContextAsync(
      'organization_operator',
      () => withSandboxPolicy(readonly, fn),
      undefined,
      'quota-host-test'
    );

  beforeEach(() => {
    savedTenant = process.env.KYBERION_TENANT;
    savedPersona = process.env.KYBERION_PERSONA;
    safeRmSync(lockPath, { recursive: true, force: true });
    safeRmSync(externalLockPath, { recursive: true, force: true });
    _resetTenantRateLimitStateForTests();
    _resetTenantRateLimitPolicyCacheForTests();
  });

  afterEach(() => {
    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    safeRmSync(lockPath, { recursive: true, force: true });
    safeRmSync(externalLockPath, { recursive: true, force: true });
    _resetTenantRateLimitStateForTests();
    _resetTenantRateLimitPolicyCacheForTests();
  });

  it('accounts quota and releases its lock while the actual operation stays read-only', async () => {
    const arbitrary = pathResolver.sharedTmp('quota-model-write.txt');
    await advisory(async () => {
      await expect(
        withTenantBudget({ op: 'planner', cost: 1 }, async () => {
          expect(getActiveSandboxPolicy()).toEqual(readonly);
          expect(currentResourceAccessScope()).toBeUndefined();
          expect(() => safeWriteFile(arbitrary, 'effect')).toThrow('SANDBOX_WRITE_DENIED');
          return 'plan';
        })
      ).resolves.toBe('plan');
      expect(inspectTenantBudget('quota-host-test').tokens).toBeLessThan(60);
      expect(safeExistsSync(lockPath)).toBe(false);
      expect(getActiveSandboxPolicy()).toEqual(readonly);
    });
    expect(safeExistsSync(arbitrary)).toBe(false);
  });

  it('reclaims a malformed lock under the exact host scope and continues enforcing denial', async () => {
    safeWriteFile(lockPath, '{');
    await advisory(async () => {
      expect(consumeTenantBudget({ op: 'planner', cost: 9999 }).allowed).toBe(false);
      expect(safeExistsSync(lockPath)).toBe(false);
      expect(getActiveSandboxPolicy()).toEqual(readonly);
    });
  });

  it('does not relax the sandbox for input getters or other tenants', async () => {
    await advisory(async () => {
      const input = {
        op: 'planner',
        get cost() {
          expect(getActiveSandboxPolicy()).toEqual(readonly);
          safeWriteFile(pathResolver.sharedTmp('quota-getter-write.txt'), 'effect');
          return 1;
        },
      };
      expect(() => consumeTenantBudget(input)).toThrow('SANDBOX_WRITE_DENIED');
      expect(() => consumeTenantBudget({ op: 'planner', tenantSlug: 'other-tenant' })).toThrow(
        'RESOURCE_SCOPE_DENIED'
      );
      expect(safeExistsSync(lockPath)).toBe(false);
    });
    await withSandboxPolicy(readonly, async () => {
      expect(() => consumeTenantBudget({ op: 'planner', tenantSlug: 'quota-host-test' })).toThrow(
        'RESOURCE_SCOPE_DENIED'
      );
    });
  });

  it('preserves a restrictive parent capability on quota lock creation', async () => {
    await advisory(async () => {
      runInResourceAccessScope(
        {
          tenantSlug: 'quota-host-test',
          readExact: [],
          writeExact: [],
          mkdirExact: [],
          allowProductKnowledgeRead: true,
        },
        () => {
          expect(() => consumeTenantBudget({ op: 'planner' })).toThrow('RESOURCE_SCOPE_DENIED');
          expect(getActiveSandboxPolicy()).toEqual(readonly);
        }
      );
      expect(safeExistsSync(lockPath)).toBe(false);
    });
  });

  it('normalizes lock records and rejects unsafe PID shapes', () => {
    expect(
      normalizeTenantRateLimitLockRecord({ pid: 42, created_at: '2026-09-01T00:00:00Z' })
    ).toEqual({
      pid: 42,
      created_at: '2026-09-01T00:00:00Z',
    });
    expect(normalizeTenantRateLimitLockRecord({ pid: 0 })).toBeNull();
    expect(normalizeTenantRateLimitLockRecord({ pid: 1.5 })).toBeNull();
    expect(normalizeTenantRateLimitLockRecord({ pid: Number.NaN })).toBeNull();
    expect(normalizeTenantRateLimitLockRecord({ pid: '42' })).toBeNull();
    expect(normalizeTenantRateLimitLockRecord([])).toBeNull();
  });

  it('does not read through a symlinked lock file before reclaiming it', () => {
    safeWriteFile(
      externalLockPath,
      JSON.stringify({ pid: process.pid, created_at: '2026-09-06T00:00:00.000Z' })
    );
    safeSymlinkSync(externalLockPath, lockPath, 'file');

    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'worker';
    expect(consumeTenantBudget({ op: 'wisdom:a2a_fanout', cost: 1 })).toMatchObject({
      allowed: true,
    });
    expect(safeReadFile(externalLockPath, { encoding: 'utf8' })).toContain(String(process.pid));
    expect(() => safeReadFile(lockPath, { encoding: 'utf8' })).toThrow();

    safeRmSync(externalLockPath, { recursive: true, force: true });
  });

  it('reclaims a malformed lock through the stale-lock path', () => {
    safeWriteFile(lockPath, '{');
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'worker';

    expect(consumeTenantBudget({ op: 'wisdom:a2a_fanout', cost: 1 })).toMatchObject({
      allowed: true,
    });
  });

  it('passes through when no tenant slug is bound (tenant-agnostic)', () => {
    delete process.env.KYBERION_TENANT;
    process.env.KYBERION_PERSONA = 'worker';
    const decision = consumeTenantBudget({ op: 'wisdom:a2a_fanout' });
    expect(decision.allowed).toBe(true);
  });

  it('exempt personas (sovereign / ecosystem_architect) bypass the limit', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    // Even with cost > capacity, ecosystem_architect should be exempt.
    const decision = consumeTenantBudget({ op: 'wisdom:a2a_fanout', cost: 9999 });
    expect(decision.allowed).toBe(true);
  });

  it('debits the tenant bucket on each consume and refuses when empty', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'worker';
    // Default policy: 60 burst, 60/min refill. Force a frozen "now" so refill doesn't kick in.
    const fixedNow = new Date('2026-04-27T00:00:00Z');
    const denyAfter = 60;
    for (let i = 0; i < denyAfter; i++) {
      const d = consumeTenantBudget({
        op: 'wisdom:a2a_fanout',
        cost: 1,
        now: fixedNow,
      });
      expect(d.allowed).toBe(true);
    }
    const denied = consumeTenantBudget({
      op: 'wisdom:a2a_fanout',
      cost: 1,
      now: fixedNow,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.retry_after_ms).toBeGreaterThan(0);
    expect(denied.reason).toMatch(/RATE_LIMIT/);
  });

  it('refills tokens over time (linear refill rate)', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'worker';
    const start = new Date('2026-04-27T00:00:00Z');
    // Drain the bucket
    for (let i = 0; i < 60; i++) {
      consumeTenantBudget({ op: 'wisdom:a2a_fanout', cost: 1, now: start });
    }
    // After 30 seconds, refill should add ~30 tokens at default 60 / min
    const later = new Date(start.getTime() + 30_000);
    const decision = consumeTenantBudget({ op: 'wisdom:a2a_fanout', cost: 10, now: later });
    expect(decision.allowed).toBe(true);
    expect(decision.tokens_remaining).toBeGreaterThan(0);
  });

  it('inspectTenantBudget reads without mutating state', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'worker';
    const before = inspectTenantBudget('acme-corp');
    const after = inspectTenantBudget('acme-corp');
    expect(after.tokens).toBeCloseTo(before.tokens, 1);
    expect(after.capacity).toBe(before.capacity);
  });

  it('withTenantBudget throws TenantRateLimitExceededError on denial', async () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'worker';
    // Drain the bucket using consumeTenantBudget directly (60 of cost 1)
    const start = new Date('2026-04-27T00:00:00Z');
    for (let i = 0; i < 60; i++) {
      consumeTenantBudget({ op: 'wisdom:a2a_fanout', cost: 1, now: start });
    }
    // Next call via withTenantBudget should throw — but withTenantBudget
    // uses real Date. To make the test deterministic, just verify the
    // error class exists and has the right shape.
    let caught: unknown;
    try {
      await withTenantBudget({ op: 'wisdom:a2a_fanout', cost: 9999 }, async () => 'never');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TenantRateLimitExceededError);
    if (caught instanceof TenantRateLimitExceededError) {
      expect(caught.code).toBe('TENANT_RATE_LIMIT_EXCEEDED');
      expect(caught.retryAfterMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('rejects schema-invalid persisted state instead of resetting quota history', () => {
    safeWriteFile(
      pathResolver.rootResolve('active/shared/runtime/tenant-rate-limit-state.json'),
      JSON.stringify({ tenants: { 'acme-corp': { tokens: 'not-a-number', updated_at: 'bad' } } })
    );
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'worker';

    expect(() => consumeTenantBudget({ op: 'wisdom:a2a_fanout', cost: 1 })).toThrow(
      'Invalid catalog tenant-rate-limit-state'
    );
  });

  it('persists a canonical state payload after quota enforcement', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'worker';
    consumeTenantBudget({ op: 'wisdom:a2a_fanout', cost: 1 });

    const persisted = JSON.parse(
      String(
        safeReadFile(
          pathResolver.rootResolve('active/shared/runtime/tenant-rate-limit-state.json'),
          { encoding: 'utf8' }
        )
      )
    ) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('$schema');
    expect(persisted.tenants).toHaveProperty('acme-corp');
  });
});

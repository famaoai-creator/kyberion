import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile, safeWriteFile } from './secure-io.js';
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
  let savedTenant: string | undefined;
  let savedPersona: string | undefined;

  beforeEach(() => {
    savedTenant = process.env.KYBERION_TENANT;
    savedPersona = process.env.KYBERION_PERSONA;
    _resetTenantRateLimitStateForTests();
    _resetTenantRateLimitPolicyCacheForTests();
  });

  afterEach(() => {
    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    _resetTenantRateLimitStateForTests();
    _resetTenantRateLimitPolicyCacheForTests();
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

  it('discards schema-invalid persisted state before enforcing a budget', () => {
    safeWriteFile(
      pathResolver.rootResolve('active/shared/runtime/tenant-rate-limit-state.json'),
      JSON.stringify({ tenants: { 'acme-corp': { tokens: 'not-a-number', updated_at: 'bad' } } })
    );
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'worker';

    expect(consumeTenantBudget({ op: 'wisdom:a2a_fanout', cost: 1 })).toMatchObject({
      allowed: true,
    });
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

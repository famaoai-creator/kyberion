import { describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  checkSpendGuard,
  loadSpendPolicy,
  resolveSpendPolicyForTenant,
  SpendCapExceededError,
  sumSpend,
  type SpendPolicy,
} from './spend-guard.js';

const NOW = Date.parse('2026-07-11T12:00:00.000Z');
const TODAY = '2026-07-11T';

function entry(cost: number, at: string, missionId?: string) {
  return { cost_usd: cost, timestamp: at, ...(missionId ? { mission_id: missionId } : {}) };
}

const WARN_POLICY: SpendPolicy = { posture: 'warn', daily_cap_usd: 10, mission_cap_usd: 5 };
const BLOCK_POLICY: SpendPolicy = { posture: 'block', daily_cap_usd: 10, mission_cap_usd: 5 };

describe('sumSpend', () => {
  it('sums only entries inside the window and attributes mission spend', () => {
    const spend = sumSpend(
      [
        entry(2, `${TODAY}01:00:00.000Z`, 'MSN-1'),
        entry(3, `${TODAY}02:00:00.000Z`),
        entry(9, '2026-07-10T23:00:00.000Z'), // yesterday — excluded
        { cost_usd: Number.NaN, timestamp: `${TODAY}03:00:00.000Z` },
      ],
      { sinceMs: Date.parse(`${TODAY}00:00:00.000Z`), missionId: 'MSN-1' }
    );
    expect(spend).toEqual({ daily: 5, mission: 2, unknown: 1 });
  });
});

describe('spend policy loading', () => {
  it('uses the canonical policy without a duplicated fallback', () => {
    const source = safeReadFile(pathResolver.rootResolve('libs/core/spend-guard.ts'), {
      encoding: 'utf8',
    }) as string;
    expect(source).not.toContain('DEFAULT_POLICY');
    expect(source).not.toContain('fallback:');
  });
});

describe('checkSpendGuard', () => {
  it('does not grant cap headroom when observed costs are unknown', () => {
    const entries = [
      { timestamp: `${TODAY}01:00:00.000Z`, cost_status: 'unknown' as const, cost_usd: null },
    ];
    const alert = vi.fn();
    const blocked = checkSpendGuard({
      now: NOW,
      policy: BLOCK_POLICY,
      entries,
      tenantId: 'unknown-cost-block',
      alert: alert as never,
    });
    expect(blocked).toMatchObject({
      allowed: false,
      daily_spent_usd: 0,
      cost_complete: false,
      unknown_cost_calls: 1,
      breached: [],
    });
    expect(new SpendCapExceededError(blocked).message).toContain('spend unavailable');
    expect(alert).toHaveBeenCalledOnce();
    const warned = checkSpendGuard({
      now: NOW,
      policy: WARN_POLICY,
      entries,
      tenantId: 'unknown-cost-warn',
      alert: vi.fn() as never,
    });
    expect(warned).toMatchObject({ allowed: true, cost_complete: false });
    for (const evidence of [
      { reference_cost_usd: 1, cost_source: 'provider_report' as const },
      { usage_source: 'provider' as const },
      { usage: { prompt_tokens: 10 } },
    ])
      expect(
        checkSpendGuard({
          now: NOW,
          policy: BLOCK_POLICY,
          entries: [{ timestamp: `${TODAY}01:00:00.000Z`, ...evidence }],
          tenantId: 'unknown-cost-reference',
          alert: vi.fn() as never,
        })
      ).toMatchObject({ allowed: false, cost_complete: false, unknown_cost_calls: 1 });
    expect(
      checkSpendGuard({
        now: NOW,
        policy: BLOCK_POLICY,
        entries: [{ cost_status: 'unknown', timestamp: 'unparseable' }],
        tenantId: 'unknown-cost-time',
        alert: vi.fn() as never,
      })
    ).toMatchObject({ allowed: false, cost_complete: false });
  });

  it('treats known reported zero and verified included runs as complete without charging reference costs', () => {
    const result = checkSpendGuard({
      now: NOW,
      policy: BLOCK_POLICY,
      entries: [
        { timestamp: `${TODAY}01:00:00.000Z`, reported_cost_usd: 0, cost_usd: 99 },
        {
          timestamp: `${TODAY}02:00:00.000Z`,
          cost_status: 'included',
          billing_mode: 'subscription_included',
          reference_cost_usd: 99,
        },
        { timestamp: '2026-07-10T00:00:00Z', cost_status: 'unknown' },
      ],
      alert: vi.fn() as never,
    });
    expect(result).toMatchObject({
      allowed: true,
      daily_spent_usd: 0,
      cost_complete: true,
      unknown_cost_calls: 0,
    });
  });
  it('allows and stays silent under the caps', () => {
    const alert = vi.fn();
    const result = checkSpendGuard({
      now: NOW,
      policy: WARN_POLICY,
      entries: [entry(1, `${TODAY}01:00:00.000Z`)],
      alert: alert as never,
    });
    expect(result.allowed).toBe(true);
    expect(result.breached).toEqual([]);
    expect(alert).not.toHaveBeenCalled();
  });

  it('warn posture: breach alerts (deduped per day) but the call proceeds', () => {
    const alert = vi.fn();
    const entries = [entry(11, `${TODAY}01:00:00.000Z`)];
    const first = checkSpendGuard({
      now: NOW,
      policy: WARN_POLICY,
      entries,
      alert: alert as never,
    });
    expect(first.allowed).toBe(true);
    expect(first.breached).toEqual(['daily']);
    expect(alert).toHaveBeenCalledOnce();
    expect(alert.mock.calls[0][0].severity).toBe('warning');

    // Same-day repeat breach: no second alert.
    checkSpendGuard({ now: NOW + 1000, policy: WARN_POLICY, entries, alert: alert as never });
    expect(alert).toHaveBeenCalledOnce();
  });

  it('block posture denies and SpendCapExceededError carries the numbers', () => {
    const result = checkSpendGuard({
      now: NOW,
      policy: BLOCK_POLICY,
      entries: [entry(6, `${TODAY}01:00:00.000Z`, 'MSN-9')],
      missionId: 'MSN-9',
      alert: vi.fn() as never,
    });
    expect(result.allowed).toBe(false);
    expect(result.breached).toEqual(['mission']);

    const error = new SpendCapExceededError(result);
    expect(error.message).toContain('cap reached');
    expect(error.message).toContain('approve to continue');
  });

  it('mission cap only applies when a mission id is in scope', () => {
    const result = checkSpendGuard({
      now: NOW,
      policy: BLOCK_POLICY,
      entries: [entry(6, `${TODAY}01:00:00.000Z`, 'MSN-9')],
      alert: vi.fn() as never,
    });
    expect(result.breached).toEqual([]);
    expect(result.mission_spent_usd).toBeUndefined();
  });
});

describe('tenant overrides (OP-01 Task 3)', () => {
  const TENANT_POLICY: SpendPolicy = {
    posture: 'warn',
    daily_cap_usd: 10,
    mission_cap_usd: 5,
    tenant_overrides: {
      'acme-corp': { posture: 'block', daily_cap_usd: 2 },
    },
  };

  it('applies the tenant override on top of the base policy', () => {
    const resolved = resolveSpendPolicyForTenant(TENANT_POLICY, 'acme-corp');
    expect(resolved).toEqual({ posture: 'block', daily_cap_usd: 2, mission_cap_usd: 5 });
  });

  it('keeps the base policy for unknown tenants', () => {
    expect(resolveSpendPolicyForTenant(TENANT_POLICY, 'other')).toBe(TENANT_POLICY);
    expect(resolveSpendPolicyForTenant(TENANT_POLICY)).toBe(TENANT_POLICY);
  });

  it('checkSpendGuard enforces the tenant cap and posture', () => {
    const alert = vi.fn();
    const result = checkSpendGuard({
      now: NOW,
      policy: TENANT_POLICY,
      tenantId: 'acme-corp',
      entries: [entry(3, `${TODAY}01:00:00.000Z`)],
      alert: alert as never,
    });
    expect(result.allowed).toBe(false); // block posture + $3 > $2 tenant cap
    expect(result.daily_cap_usd).toBe(2);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0].dedupe_key).toContain('acme-corp');
  });

  it('other tenants keep the generous base cap', () => {
    const alert = vi.fn();
    const result = checkSpendGuard({
      now: NOW,
      policy: TENANT_POLICY,
      tenantId: 'other-tenant',
      entries: [entry(3, `${TODAY}01:00:00.000Z`)],
      alert: alert as never,
    });
    expect(result.allowed).toBe(true);
    expect(result.breached).toEqual([]);
  });
});

describe('loadSpendPolicy', () => {
  it('loads the governed policy with a warn default posture', () => {
    const policy = loadSpendPolicy();
    expect(policy.posture).toBe('warn');
    expect(policy.daily_cap_usd).toBeGreaterThan(0);
    expect(policy.mission_cap_usd).toBeGreaterThan(0);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeBudgetUsage,
  evaluateBudgetThrottle,
  loadOrgBudgetPolicy,
  maybeAlertBudgetThreshold,
  resetOrgBudgetAlertState,
  resetOrgBudgetPolicyCache,
  type OrgBudgetPolicy,
} from './org-budget-governor.js';

const now = () => new Date('2026-10-04T10:00:00Z');
const policy: OrgBudgetPolicy = {
  daily_token_cap: 1000,
  daily_cost_cap_usd: 10,
  soft_ratio: 0.8,
  hard_ratio: 1,
  tenant_overrides: { big: { daily_token_cap: 5000 } },
  organization_overrides: { 'org-x': { daily_token_cap: 100 } } as any,
};
const charters = [
  { charter: { dot_id: 'a', scope: { tenant_slug: 'acme', organization_id: 'o1' } } },
  { charter: { dot_id: 'b', scope: { tenant_slug: 'big' } } },
] as any;
const base = (extra: Record<string, unknown> = {}) => ({
  now,
  policy,
  listCharters: () => charters,
  readDotTokenUsage: () => [
    { dot_id: 'a', day: '2026-10-04', tokens: 500 },
    { dot_id: 'a', day: '2026-10-03', tokens: 9999 },
    { dot_id: 'b', day: '2026-10-04', tokens: 700 },
  ],
  readMetricsHistory: () => [
    {
      timestamp: '2026-10-04T01:00:00Z',
      tenant_slug: 'acme',
      usage: { prompt_tokens: 300, completion_tokens: 50 },
      cost_usd: 2,
    },
    {
      timestamp: '2026-10-03T01:00:00Z',
      tenant_slug: 'acme',
      usage: { prompt_tokens: 999 },
      cost_usd: 99,
    },
  ],
  readGenerationUnits: () => 3,
  ...extra,
});

describe('org-budget-governor', () => {
  beforeEach(() => {
    resetOrgBudgetAlertState();
    resetOrgBudgetPolicyCache();
  });

  it('aggregates today only, scoped per tenant', () => {
    const u = computeBudgetUsage({ tenant_slug: 'acme' }, base());
    expect(u.tokens).toBe(850);
    expect(u.by_source).toEqual({ dots: 500, missions: 350, generation: 3 });
    expect(u.cost_usd).toBe(2);
    expect(computeBudgetUsage({ tenant_slug: 'big' }, base()).tokens).toBe(700);
  });

  it('maps ratios to normal/soft/hard with overrides', () => {
    expect(evaluateBudgetThrottle({ tenant_slug: 'big' }, base()).throttle).toBe('normal');
    const soft = evaluateBudgetThrottle({ tenant_slug: 'acme' }, base());
    expect(soft.throttle).toBe('soft');
    expect(soft.reason).toContain('soft');
    const hard = evaluateBudgetThrottle(
      { tenant_slug: 'acme' },
      base({ readDotTokenUsage: () => [{ dot_id: 'a', day: '2026-10-04', tokens: 900 }] })
    );
    expect(hard.throttle).toBe('hard');
  });

  it('cost cap can drive the throttle', () => {
    const e = evaluateBudgetThrottle(
      { tenant_slug: 'acme' },
      base({
        readDotTokenUsage: () => [],
        readMetricsHistory: () => [
          { timestamp: '2026-10-04T01:00:00Z', tenant_slug: 'acme', cost_usd: 11 },
        ],
      })
    );
    expect(e.throttle).toBe('hard');
    expect(e.reason).toContain('cost');
  });

  it('alerts once per scope/day/throttle', () => {
    const alert = vi.fn();
    const e = evaluateBudgetThrottle({ tenant_slug: 'acme' }, base());
    expect(maybeAlertBudgetThreshold(e, { alert })).toBe(true);
    expect(maybeAlertBudgetThreshold(e, { alert })).toBe(false);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0].dedupe_key).toBe('org-budget:acme:2026-10-04:soft');
    const normal = evaluateBudgetThrottle({ tenant_slug: 'big' }, base());
    expect(maybeAlertBudgetThreshold(normal, { alert })).toBe(false);
  });

  it('loads the shipped policy with cost cap inherited and caches 60 s', () => {
    const p = loadOrgBudgetPolicy(now);
    expect(p.daily_token_cap).toBe(3_000_000);
    expect(p.soft_ratio).toBe(0.8);
    expect(p.daily_cost_cap_usd).toBe(50);
    expect(loadOrgBudgetPolicy(now)).toBe(p);
  });
});

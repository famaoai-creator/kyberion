import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeBudgetUsage,
  evaluateBudgetThrottle,
  loadOrgBudgetPolicy,
  maybeAlertBudgetThreshold,
  resetOrgBudgetAlertState,
  resetOrgBudgetPolicyCache,
  resetOrgBudgetThrottleCache,
  resolveOrgBudgetPolicy,
  type OrgBudgetPolicy,
} from './org-budget-governor.js';
import type { LoadedDotCharter } from '../dot/dot-charter.js';

const now = () => new Date('2026-10-04T10:00:00Z');
const policy: OrgBudgetPolicy = {
  daily_token_cap: 1000,
  daily_cost_cap_usd: 10,
  soft_ratio: 0.8,
  hard_ratio: 1,
  tenant_overrides: { big: { daily_token_cap: 5000 } },
  organization_overrides: { 'org-x': { daily_token_cap: 100 } },
};
const charters = [
  { charter: { dot_id: 'a', scope: { tenant_slug: 'acme', organization_id: 'o1' } } },
  { charter: { dot_id: 'b', scope: { tenant_slug: 'big' } } },
] as unknown as Array<Pick<LoadedDotCharter, 'charter'>>;
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
  throttleCacheMs: 0,
  ...extra,
});

describe('org-budget-governor', () => {
  beforeEach(() => {
    resetOrgBudgetAlertState();
    resetOrgBudgetPolicyCache();
    resetOrgBudgetThrottleCache();
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

  // Row shapes as MetricsCollector.record persists them (component + ...extra).
  const askRow = {
    component: 'agent-runtime:ask',
    timestamp: '2026-10-04T02:00:00Z',
    status: 'success',
    agent: 'agent-x',
    provider: 'anthropic',
    model: 'claude-sonnet',
    scope: { scope_kind: 'organization', tenant_slug: 'acme', organization_id: 'o1' },
    usage: { prompt_tokens: 100, completion_tokens: 20 },
    cost_usd: 1,
  };
  const missionSdkRow = {
    component: 'anthropic-sdk',
    timestamp: '2026-10-04T03:00:00Z',
    agent: 'anthropic-sdk',
    cause: 'assistant',
    mission_id: 'MSN-X',
    usage: { prompt_tokens: 40, completion_tokens: 10, cache_read_tokens: 50 },
    cost_usd: 0.5,
  };
  // A dot wake metered by the backend: no mission, no scope, no tenant.
  const unattributedSdkRow = {
    component: 'anthropic-sdk',
    timestamp: '2026-10-04T04:00:00Z',
    agent: 'anthropic-sdk',
    cause: 'assistant',
    usage: { prompt_tokens: 600, completion_tokens: 100 },
    cost_usd: 3,
  };
  const dotTaggedRow = {
    component: 'claude-cli',
    timestamp: '2026-10-04T05:00:00Z',
    agent: 'dot:repo-guardian',
    mission_id: 'MSN-Y',
    usage: { prompt_tokens: 900 },
    cost_usd: 0.25,
  };
  const realRows = () => [askRow, missionSdkRow, unattributedSdkRow, dotTaggedRow];

  it('scopes metrics rows by their EventScope tenant / organization', () => {
    const acme = computeBudgetUsage(
      { tenant_slug: 'acme' },
      base({ readDotTokenUsage: () => [], readMetricsHistory: realRows })
    );
    expect(acme.by_source.missions).toBe(120);
    expect(acme.cost_usd).toBe(1);
    const org = computeBudgetUsage(
      { organization_id: 'o1' },
      base({ readDotTokenUsage: () => [], readMetricsHistory: realRows })
    );
    expect(org.by_source.missions).toBe(120);
    expect(
      computeBudgetUsage(
        { tenant_slug: 'big' },
        base({ readDotTokenUsage: () => [], readMetricsHistory: realRows })
      ).by_source.missions
    ).toBe(0);
  });

  it('does not double count dot tokens in the global scope, but keeps their cost', () => {
    const global = computeBudgetUsage({}, base({ readMetricsHistory: realRows }));
    // dots: 500 (a) + 700 (b); missions: ask 120 + mission sdk 100.
    expect(global.by_source).toEqual({ dots: 1200, missions: 220, generation: 0 });
    expect(global.tokens).toBe(1420);
    expect(global.cost_usd).toBe(4.75);
  });

  it('caches the throttle per scope for 60 s and per UTC day', () => {
    let t = new Date('2026-10-04T10:00:00Z');
    let tokens = 100;
    const deps = base({
      now: () => t,
      throttleCacheMs: undefined,
      readMetricsHistory: () => [],
      readDotTokenUsage: () => [{ dot_id: 'a', day: t.toISOString().slice(0, 10), tokens }],
    });
    expect(evaluateBudgetThrottle({ tenant_slug: 'acme' }, deps).throttle).toBe('normal');
    tokens = 2000;
    t = new Date('2026-10-04T10:00:59Z');
    expect(evaluateBudgetThrottle({ tenant_slug: 'acme' }, deps).throttle).toBe('normal');
    // A different scope is evaluated on its own.
    expect(
      evaluateBudgetThrottle({ tenant_slug: 'acme', organization_id: 'o1' }, deps).throttle
    ).toBe('hard');
    t = new Date('2026-10-04T10:01:00Z');
    expect(evaluateBudgetThrottle({ tenant_slug: 'acme' }, deps).throttle).toBe('hard');
    tokens = 0;
    resetOrgBudgetThrottleCache();
    expect(evaluateBudgetThrottle({ tenant_slug: 'acme' }, deps).throttle).toBe('normal');
  });

  it('inherits spend-policy tenant daily_cap_usd as the tenant cost cap', () => {
    const p = resolveOrgBudgetPolicy({
      daily_cap_usd: 50,
      tenant_overrides: { acme: { daily_cap_usd: 5 }, big: { daily_cap_usd: 7 } },
      org_budget: {
        daily_token_cap: 1000,
        soft_ratio: 0.8,
        hard_ratio: 1,
        tenant_overrides: { big: { daily_cost_cap_usd: 30 } },
      },
    });
    expect(p.daily_cost_cap_usd).toBe(50);
    expect(p.tenant_overrides).toEqual({
      acme: { daily_cost_cap_usd: 5 },
      big: { daily_cost_cap_usd: 30 },
    });
    const e = evaluateBudgetThrottle(
      { tenant_slug: 'acme' },
      base({
        policy: p,
        readDotTokenUsage: () => [],
        readMetricsHistory: () => [askRow],
        readGenerationUnits: () => 0,
      })
    );
    expect(e.cap.daily_cost_cap_usd).toBe(5);
    expect(e.throttle).toBe('normal');
  });
});

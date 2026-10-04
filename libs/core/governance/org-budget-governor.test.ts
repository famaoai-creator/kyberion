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
import { metrics, MetricsCollector } from '../metrics.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';

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

  it("fails closed for today's ambiguous cost evidence only when a cost cap is configured", () => {
    // Dot-attributed usage for an unknown charter with no scope could be acme's.
    const deps = base({
      readDotTokenUsage: () => [],
      readMetricsHistory: () => [{ ...unattributedSdkRow, actor_id: 'dot:ghost' }],
    });
    const unknown = evaluateBudgetThrottle({ tenant_slug: 'acme' }, deps);
    expect(unknown.usage).toMatchObject({ cost_usd: 0, cost_status: 'unknown' });
    expect(unknown.throttle).toBe('hard');
    expect(unknown.reason).toContain('missing cost or scope evidence');
    expect(
      evaluateBudgetThrottle(
        { tenant_slug: 'acme' },
        {
          ...deps,
          policy: { daily_token_cap: 1000, soft_ratio: 0.8, hard_ratio: 1 },
        }
      ).throttle
    ).toBe('normal');
    expect(
      evaluateBudgetThrottle(
        { tenant_slug: 'acme' },
        {
          ...deps,
          now: () => new Date('2026-10-05T10:00:00Z'),
        }
      ).throttle
    ).toBe('normal');
  });

  it('keeps a tenant normal under the shipped spend policy despite unscoped operator CLI usage', () => {
    // As recordCliUsage persists a Claude Code session outside any tenant context.
    const cliRow = {
      component: 'claude-code-cli',
      timestamp: '2026-10-04T06:00:00Z',
      agent: 'claude-code-cli',
      turns: 4,
      usage: { prompt_tokens: 50_000, completion_tokens: 4_000 },
      cost_usd: 30,
    };
    const deps = base({
      policy: resolveOrgBudgetPolicy({ daily_cap_usd: 50 }),
      readDotTokenUsage: () => [],
      readMetricsHistory: () => [cliRow, unattributedSdkRow],
    });
    const tenant = evaluateBudgetThrottle({ tenant_slug: 'acme' }, deps);
    expect(tenant.throttle).toBe('normal');
    expect(tenant.usage.cost_status).toBeUndefined();
    // The global scope reports interactive CLI sessions but never caps repo dots on them.
    const global = evaluateBudgetThrottle(
      {},
      {
        ...deps,
        policy: { daily_token_cap: 10_000, daily_cost_cap_usd: 10, soft_ratio: 0.8, hard_ratio: 1 },
        readMetricsHistory: () => [cliRow, { ...cliRow, cost_usd: undefined }],
      }
    );
    expect(global.usage.by_source).toMatchObject({ missions: 0, interactive: 108_000 });
    expect(global.usage).toMatchObject({ tokens: 0, cost_usd: 0 });
    expect(global.usage.cost_status).toBeUndefined();
    expect(global.throttle).toBe('normal');
    // Attributed CLI rows (explicit scope) remain a cap input.
    const scoped = evaluateBudgetThrottle(
      {},
      { ...deps, readMetricsHistory: () => [{ ...cliRow, tenant_slug: 'acme' }] }
    );
    expect(scoped.usage.by_source.missions).toBe(54_000);
    expect(scoped.usage.by_source.interactive).toBeUndefined();
  });

  it('resolves unscoped legacy dot rows through the charter instead of pausing others', () => {
    const legacy = { ...unattributedSdkRow, agent: 'dot:b', cost_usd: undefined };
    const deps = base({ readDotTokenUsage: () => [], readMetricsHistory: () => [legacy] });
    expect(evaluateBudgetThrottle({ tenant_slug: 'acme' }, deps).throttle).toBe('normal');
    const big = evaluateBudgetThrottle({ tenant_slug: 'big' }, deps);
    expect(big.usage.by_source.dots).toBe(700);
    // Attributable dot usage with unknown cost stays conservative in its own scope.
    expect(big.usage.cost_status).toBe('unknown');
    expect(big.throttle).toBe('hard');
  });

  it('does not treat known other-tenant or system costs as ambiguous for this tenant', () => {
    const evaluation = evaluateBudgetThrottle(
      { tenant_slug: 'acme' },
      base({
        readDotTokenUsage: () => [],
        readMetricsHistory: () => [
          { ...unattributedSdkRow, tenant_slug: 'other' },
          { ...unattributedSdkRow, scope: { scope_kind: 'system', tier: 'public' } },
        ],
      })
    );
    expect(evaluation.throttle).toBe('normal');
    expect(evaluation.usage.cost_usd).toBe(0);
    expect(evaluation.usage.cost_status).toBeUndefined();
  });

  it.each(['missing cost', 'unreadable history'] as const)(
    'reports %s as unknown rather than zero spend',
    (failure) => {
      const evaluation = evaluateBudgetThrottle(
        { tenant_slug: 'acme' },
        base({
          readDotTokenUsage: () => [],
          readMetricsHistory: () => {
            if (failure === 'unreadable history') throw new Error('history unavailable');
            return [{ ...askRow, cost_usd: undefined }];
          },
        })
      );
      expect(evaluation.throttle).toBe('hard');
      expect(evaluation.usage.cost_status).toBe('unknown');
    }
  );

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

  it('opts the production history reader into strict evidence reads', () => {
    const metricsDir = 'active/shared/tmp/org-budget-strict-history-tests';
    const collector = new MetricsCollector({
      metricsDir,
      metricsFile: 'history.jsonl',
      persist: false,
    });
    const history = vi
      .spyOn(metrics, 'loadHistory')
      .mockImplementation((options) => collector.loadHistory(options));
    const deps = base({ readMetricsHistory: undefined, readDotTokenUsage: () => [] });
    try {
      safeMkdir(metricsDir, { recursive: true });
      expect(evaluateBudgetThrottle({ tenant_slug: 'acme' }, deps).throttle).toBe('normal');
      // Torn lines dated yesterday are skipped; one undatable line is tolerated.
      const yesterday = '{"timestamp":"2026-10-03T23:59:00Z","usage":{"prompt_tok\n';
      safeWriteFile(`${metricsDir}/history.jsonl`, yesterday.repeat(5) + '{corrupt\n');
      expect(evaluateBudgetThrottle({ tenant_slug: 'acme' }, deps).throttle).toBe('normal');
      expect(history).toHaveBeenCalledWith(expect.objectContaining({ strict: true }));
      // Undatable torn lines before the first today-dated line belong to earlier days.
      const todayOk = '{"timestamp":"2026-10-04T00:30:00Z","component":"probe"}\n';
      safeWriteFile(`${metricsDir}/history.jsonl`, yesterday + '{corrupt\n'.repeat(4) + todayOk);
      expect(evaluateBudgetThrottle({ tenant_slug: 'acme' }, deps).usage.cost_status).toBe(
        undefined
      );
      // The same undatable lines after it count toward today's malformed total.
      safeWriteFile(`${metricsDir}/history.jsonl`, yesterday + todayOk + '{corrupt\n'.repeat(3));
      expect(evaluateBudgetThrottle({ tenant_slug: 'acme' }, deps).usage.cost_status).toBe(
        'unknown'
      );
      // Beyond the threshold, today's (or undatable) torn evidence fails closed.
      safeWriteFile(
        `${metricsDir}/history.jsonl`,
        yesterday + '{"timestamp":"2026-10-04T01:00:00Z","usa\n'.repeat(2) + '{corrupt\n'
      );
      const result = evaluateBudgetThrottle({ tenant_slug: 'acme' }, deps);
      expect(result.usage.cost_status).toBe('unknown');
      expect(result.throttle).toBe('hard');
      expect(
        evaluateBudgetThrottle(
          { tenant_slug: 'acme' },
          {
            ...deps,
            policy: { daily_token_cap: 1000, soft_ratio: 0.8, hard_ratio: 1 },
          }
        ).throttle
      ).toBe('normal');
    } finally {
      history.mockRestore();
      safeRmSync(metricsDir, { recursive: true, force: true });
    }
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

  it('conservatively counts legacy tokens without inventing accounting-ID matches', () => {
    const global = computeBudgetUsage({}, base({ readMetricsHistory: realRows }));
    expect(global.by_source).toEqual({ dots: 2100, missions: 920, generation: 0 });
    expect(global.tokens).toBe(3020);
    expect(global.cost_usd).toBe(4.75);
  });

  it('reconciles complete attempts and counts late/failed calls separately on the same dot/day', () => {
    const metric = (accounting_id: string, tokens: number) => ({
      ...askRow,
      actor_id: 'dot:a',
      accounting_id,
      usage: { prompt_tokens: tokens },
      cost_usd: 0,
    });
    const rows = [
      metric('success', 40),
      metric('success', 60),
      metric('partial', 50),
      metric('partial', 30),
    ];
    const deps = base({
      readDotTokenUsage: () => [
        { dot_id: 'a', accounting_id: 'success', day: '2026-10-04', tokens: 100 },
        { dot_id: 'a', accounting_id: 'partial', day: '2026-10-04', tokens: 40 },
      ],
      readMetricsHistory: () => rows,
    });
    expect(computeBudgetUsage({ tenant_slug: 'acme', organization_id: 'o1' }, deps).tokens).toBe(
      180
    );
    rows.push(metric('timed-out-attempt', 70));
    expect(computeBudgetUsage({ tenant_slug: 'acme', organization_id: 'o1' }, deps).tokens).toBe(
      250
    );
    rows.push(metric('timed-out-attempt', 85));
    expect(computeBudgetUsage({ tenant_slug: 'acme', organization_id: 'o1' }, deps).tokens).toBe(
      335
    );
  });

  it.each([
    { tenant_slug: 'acme', organization_id: 'o2' },
    { tenant_slug: 'other', organization_id: 'o1' },
  ])('never reconciles identical IDs across a different scope %j', (scope) => {
    const usage = computeBudgetUsage(
      {},
      base({
        readDotTokenUsage: () => [
          { dot_id: 'a', accounting_id: 'same', day: '2026-10-04', tokens: 100 },
        ],
        readMetricsHistory: () => [
          {
            ...askRow,
            scope,
            actor_id: 'dot:a',
            accounting_id: 'same',
            usage: { prompt_tokens: 70 },
          },
        ],
      })
    );
    expect(usage.tokens).toBe(170);
  });

  it('counts a late completion on its actual UTC day and leaves uncharged pipeline tokens intact', () => {
    const usage = computeBudgetUsage(
      { tenant_slug: 'acme' },
      base({
        readDotTokenUsage: () => [
          { dot_id: 'a', accounting_id: 'late', day: '2026-10-03', tokens: 100 },
        ],
        readMetricsHistory: () => [
          { ...askRow, actor_id: 'dot:a', accounting_id: 'late', usage: { prompt_tokens: 70 } },
          { ...askRow, component: 'pipeline-reasoning', usage: { prompt_tokens: 30 } },
        ],
      })
    );
    expect(usage.tokens).toBe(100);
    expect(usage.by_source).toEqual({ dots: 70, missions: 30, generation: 3 });
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

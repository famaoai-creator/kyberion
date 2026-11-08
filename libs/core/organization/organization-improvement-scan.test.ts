import { describe, expect, it } from 'vitest';
import { runOrganizationImprovementScan } from './organization-improvement-scan.js';
import type { OrganizationPurposeRecord } from './organization-operating-model.js';
import type { DotCharter } from '../dot/dot-charter.js';
import type { DotOutcomeRow, KrMeasurementRow } from '../dot/dot-state-paths.js';
import type { CostReport } from '../finance/cost-report.js';

const NOW = new Date('2026-11-08T09:00:00.000Z');
const ORG = 'org-test';

const purpose: OrganizationPurposeRecord = {
  version: '1.0.0',
  organization_id: ORG,
  name: 'Test Org',
  purpose: 'Improve continuously.',
  tier: 'confidential',
  tenant_slug: 'acme',
  owner_role: 'owner',
  approval_state: 'approved',
  updated_at: '2026-10-01T00:00:00.000Z',
  objectives: [
    {
      objective_id: 'o1',
      title: 'Ship reliably',
      key_results: [
        {
          kr_id: 'incidents',
          title: 'Open incidents',
          metric: { source: 'org_metric', metric: 'open_incidents' },
          target: 0,
          direction: 'decrease',
        },
      ],
    },
    {
      objective_id: 'o2',
      title: 'Stay within budget',
      key_results: [
        {
          kr_id: 'cost',
          title: 'Weekly cost',
          metric: { source: 'org_metric', metric: 'cost_usd', window_days: 7 },
          target: 50,
          direction: 'decrease',
        },
      ],
    },
  ],
};

const krRow = (
  kr_id: string,
  progress: number,
  measured_at: string,
  extra: Partial<KrMeasurementRow> = {}
): KrMeasurementRow => ({
  scope: 'org',
  organization_id: ORG,
  objective_id: 'o1',
  kr_id,
  value: progress * 100,
  progress,
  measured_at,
  ...extra,
});

const outcomeRow = (
  verdict: DotOutcomeRow['verdict'],
  measured_at: string,
  kr_id = 'incidents'
): DotOutcomeRow => ({
  dot_id: 'ops-dot',
  action_ref: `a-${measured_at}`,
  work_item_id: `wi-${measured_at}`,
  ref: { kr_id },
  verdict,
  due_at: measured_at,
  measured_at,
});

const orgDot = {
  dot_id: 'ops-dot',
  status: 'active',
  scope: { tier: 'confidential', tenant_slug: 'acme', organization_id: ORG },
} as unknown as DotCharter;

const bucket = (key: string, cost_usd: number, calls: number, tokens = 1000) => ({
  key,
  cost_usd,
  estimated_cost_usd: 0,
  reference_usd: 0,
  reference_cost_calls: 0,
  actual_cost_calls: calls,
  estimated_cost_calls: 0,
  included_calls: 0,
  unknown_cost_calls: 0,
  cost_complete: true,
  calls,
  prompt_tokens: tokens / 2,
  completion_tokens: tokens / 2,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cache_write_1h_tokens: 0,
});

function costReport(total: number, calls: number, unknown = 0): CostReport {
  return {
    since: null,
    until: null,
    total_usd: total,
    estimated_usd: 0,
    reference_usd: 0,
    reference_cost_calls: 0,
    actual_cost_calls: calls,
    estimated_cost_calls: 0,
    included_calls: 0,
    unknown_cost_calls: unknown,
    cost_complete: unknown === 0,
    calls,
    by_mission: [bucket('MSN-X', total, calls)],
    by_model: [bucket('model-a', total, calls)],
    by_day: [],
    actual_usd: total,
    committed_usd: 0,
    resource_usage_entries: 0,
    resource_usage_cost_usd: 0,
    by_actor: [],
    by_customer: [],
    by_cost_center: [],
    by_tenant: [],
    by_organization: [],
    by_project: [],
    by_cause: [],
  };
}

const baseDeps = {
  now: () => NOW,
  loadPurpose: () => purpose,
  readOrgKrRows: () => [
    krRow('incidents', 0.6, '2026-11-01T00:00:00Z'),
    krRow('incidents', 0.4, '2026-11-04T00:00:00Z'),
    krRow('incidents', 0.3, '2026-11-07T00:00:00Z'),
    // 'cost' KR stays unmeasured
  ],
  listCharters: () => [orgDot],
  readOutcomeRows: () => [
    outcomeRow('no_change', '2026-11-05T00:00:00Z'),
    outcomeRow('regressed', '2026-11-07T00:00:00Z'),
  ],
  costReport: (opts: { since?: string; scopeFilter?: { organization_id?: string } }) => {
    if (opts.since && opts.since < '2026-10-31') return costReport(40, 10);
    if (opts.scopeFilter?.organization_id) return costReport(90, 30, 3);
    // Unscoped baseline: 30 of 120 USD sits in the `(no organization)` bucket.
    return {
      ...costReport(120, 40),
      by_organization: [bucket('(no organization)', 30, 10), bucket(ORG, 90, 30)],
    };
  },
  readOperations: () => ({
    overdue_operations: 0,
    open_incidents: 1,
    pending_decisions: 2,
    unhealthy_services: 0,
  }),
} satisfies Parameters<typeof runOrganizationImprovementScan>[1];

describe('runOrganizationImprovementScan', () => {
  it('reports objective progress, stagnation, cost and ranked candidates', () => {
    const report = runOrganizationImprovementScan(
      { organizationId: ORG, tier: 'confidential', tenantSlug: 'acme', windowDays: 7 },
      baseDeps
    );
    expect(report.scope.organization_id).toBe(ORG);
    const o1 = report.objectives.find((o) => o.objective_id === 'o1')!;
    expect(o1.progress).toBeCloseTo(0.3);
    const o2 = report.objectives.find((o) => o.objective_id === 'o2')!;
    expect(o2.unmeasured_krs).toEqual(['cost']);
    const trend = report.kr_trends.find((t) => t.kr_id === 'incidents')!;
    expect(trend.stagnant).toBe(true);
    expect(report.cost.current.cost_usd).toBe(90);
    expect(report.cost.current.llm_calls).toBe(30);
    expect(report.cost.current.llm_tokens).toBe(1000);
    expect(report.cost.prior?.cost_usd).toBe(40);
    expect(report.cost.cost_delta_pct).toBeCloseTo(125);
    expect(report.cost.unscoped_total_usd).toBe(120);
    expect(report.cost.unattributed_usd).toBe(30);
    expect(report.cost.unattributed_share_pct).toBeCloseTo(25);
    expect(report.outcomes.non_improving_streaks).toEqual([
      { dot_id: 'ops-dot', ref: 'incidents', streak: 2, unmeasurable_only: false },
    ]);
    const rules = report.candidates.map((c) => c.rule_id);
    expect(rules).toContain('unmeasured-kr');
    expect(rules).toContain('stalled-objective');
    expect(rules).toContain('regressed-streak');
    expect(rules).toContain('unknown-cost-evidence');
    expect(rules).toContain('cost-up-progress-flat');
    expect(rules).toContain('model-concentration');
    expect(rules).toContain('pending-decisions');
    for (const c of report.candidates) {
      expect(c.candidate_id).toMatch(/^imp-[0-9a-f]{12}$/);
      expect(c.status).toBe('proposed');
      expect(c.priority_score).toBeGreaterThan(0);
      expect(c.expected_kr_effect.direction).toMatch(/increase|decrease/);
    }
    const sorted = [...report.candidates].sort((a, b) => b.priority_score - a.priority_score);
    expect(report.candidates).toEqual(sorted);
  });

  it('candidate ids are stable across runs and respect maxCandidates', () => {
    const input = { organizationId: ORG, tier: 'confidential', tenantSlug: 'acme' } as const;
    const a = runOrganizationImprovementScan(input, baseDeps);
    const b = runOrganizationImprovementScan(input, baseDeps);
    expect(a.candidates.map((c) => c.candidate_id)).toEqual(
      b.candidates.map((c) => c.candidate_id)
    );
    const capped = runOrganizationImprovementScan({ ...input, maxCandidates: 2 }, baseDeps);
    expect(capped.candidates).toHaveLength(2);
    expect(capped.candidates[0].priority_score).toBeGreaterThanOrEqual(
      capped.candidates[1].priority_score
    );
  });

  it('flags missing purpose and skips streaks outside the window', () => {
    const report = runOrganizationImprovementScan(
      { organizationId: ORG, tier: 'confidential', tenantSlug: 'acme', windowDays: 1 },
      {
        ...baseDeps,
        loadPurpose: () => null,
        readOrgKrRows: () => [],
        readOutcomeRows: () => [outcomeRow('regressed', '2026-10-01T00:00:00Z')],
      }
    );
    expect(report.purpose_missing).toBe(true);
    expect(report.candidates.some((c) => c.rule_id === 'purpose-missing')).toBe(true);
    expect(report.candidates.some((c) => c.rule_id === 'regressed-streak')).toBe(false);
  });

  it('does not flag a below-50% objective whose KRs are improving', () => {
    const report = runOrganizationImprovementScan(
      { organizationId: ORG, tier: 'confidential', tenantSlug: 'acme', windowDays: 7 },
      {
        ...baseDeps,
        readOrgKrRows: () => [
          krRow('incidents', 0.1, '2026-11-01T00:00:00Z'),
          krRow('incidents', 0.3, '2026-11-04T00:00:00Z'),
          krRow('incidents', 0.45, '2026-11-07T00:00:00Z'),
        ],
        readOutcomeRows: () => [],
      }
    );
    const o1 = report.objectives.find((o) => o.objective_id === 'o1')!;
    expect(o1.progress).toBeCloseTo(0.45);
    expect(report.kr_trends.find((t) => t.kr_id === 'incidents')!.stagnant).toBe(false);
    expect(report.candidates.some((c) => c.rule_id === 'stalled-objective')).toBe(false);
  });

  it('routes an all-unmeasurable streak to a measurement candidate', () => {
    const report = runOrganizationImprovementScan(
      { organizationId: ORG, tier: 'confidential', tenantSlug: 'acme', windowDays: 7 },
      {
        ...baseDeps,
        readOutcomeRows: () => [
          outcomeRow('unmeasurable', '2026-11-05T00:00:00Z'),
          outcomeRow('unmeasurable', '2026-11-07T00:00:00Z'),
        ],
      }
    );
    const streak = report.outcomes.non_improving_streaks[0];
    expect(streak.unmeasurable_only).toBe(true);
    const cand = report.candidates.find((c) => c.rule_id === 'unmeasurable-streak');
    expect(cand?.target_kind).toBe('measurement');
    expect(report.candidates.some((c) => c.rule_id === 'regressed-streak')).toBe(false);
  });

  it('counts only unscoped spend as unattributed — other orgs are not a scope defect', () => {
    const report = runOrganizationImprovementScan(
      { organizationId: ORG, tier: 'confidential', tenantSlug: 'acme', windowDays: 7 },
      {
        ...baseDeps,
        costReport: (opts: { since?: string; scopeFilter?: { organization_id?: string } }) => {
          if (opts.since && opts.since < '2026-10-31') return costReport(10, 4);
          if (opts.scopeFilter?.organization_id) return costReport(20, 8);
          // 60 USD sits on another org — correctly attributed, not a defect.
          return {
            ...costReport(100, 40),
            by_organization: [bucket('(no organization)', 40, 15), bucket('other-org', 60, 25)],
          };
        },
      }
    );
    expect(report.cost.unscoped_total_usd).toBe(100);
    expect(report.cost.unattributed_usd).toBe(40);
    expect(report.cost.unattributed_share_pct).toBeCloseTo(40);
    // 40% < 50% threshold → no cost-unattributed candidate.
    expect(report.candidates.some((c) => c.rule_id === 'cost-unattributed')).toBe(false);
  });

  it('scopes dots by exact organization and tenant', () => {
    const foreign = {
      dot_id: 'foreign',
      status: 'active',
      scope: { tier: 'confidential', tenant_slug: 'other', organization_id: ORG },
    } as unknown as DotCharter;
    const report = runOrganizationImprovementScan(
      { organizationId: ORG, tier: 'confidential', tenantSlug: 'acme' },
      { ...baseDeps, listCharters: () => [foreign] }
    );
    expect(report.outcomes.dots_observed).toBe(0);
  });
});

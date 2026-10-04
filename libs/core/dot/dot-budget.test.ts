import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrgBudgetEvaluation } from '../governance/org-budget-governor.js';
import { resetOrgBudgetAlertState } from '../governance/org-budget-governor.js';
import type { DotCharter } from './dot-charter.js';
import {
  DOT_BUDGET_DIGEST_SECTION,
  DOT_BUDGET_FLOOR_CONTRIBUTOR,
  DOT_BUDGET_STATUS_SECTION,
  dotBudgetScope,
  dotBudgetThrottle,
  evaluateDotBudget,
  resetDotBudgetCache,
  setDotBudgetThrottleForTests,
} from './dot-budget.js';
import {
  DOT_DIGEST_SECTIONS,
  DOT_FLOOR_CONTRIBUTORS,
  DOT_STATUS_SECTIONS,
} from './dot-extension-registry.js';
import type { DotProposal } from './dot-proposals.js';
import './dot-extension-bootstrap.js';

const CHARTER: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'acme-ops',
  version: '1.0.0',
  title: 'Acme ops',
  purpose: 'p',
  status: 'active',
  scope: { tier: 'confidential', tenant_slug: 'acme', organization_id: 'acme-org' },
  goal: { statement: 'g' },
  attention: { triggers: [{ kind: 'cron', cron: '0 9 * * *' }] },
  authority: { authority_role: 'infrastructure_sentinel' },
  notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
  runtime: { heartbeat_id: 'dot-acme-ops' },
};
const PROPOSAL = {
  action_id: 'dot_delegate_work',
  title: 't',
  objective: 'o',
  work_shape: 'task_session',
} as DotProposal;
const NOW = new Date('2026-10-04T10:00:00Z');

function evaluation(
  tokens: number,
  throttle: OrgBudgetEvaluation['throttle']
): OrgBudgetEvaluation {
  return {
    throttle,
    usage: {
      scope: { tenant_slug: 'acme' },
      day: '2026-10-04',
      tokens,
      cost_usd: 0,
      by_source: { dots: tokens, missions: 0, generation: 0 },
    },
    cap: { daily_token_cap: 1000, soft_ratio: 0.8, hard_ratio: 1 },
    ...(throttle === 'normal'
      ? {}
      : { reason: `${throttle} budget threshold reached (tokens ${tokens}/1000)` }),
  };
}

afterEach(() => {
  setDotBudgetThrottleForTests(undefined);
  resetDotBudgetCache();
  resetOrgBudgetAlertState();
});

describe('dotBudgetThrottle', () => {
  it('evaluates the charter tenant/org scope, caches per scope and alerts once per threshold', () => {
    const evaluate = vi.fn(() => evaluation(850, 'soft'));
    const alert = vi.fn();
    expect(dotBudgetScope(CHARTER)).toEqual({ tenant_slug: 'acme', organization_id: 'acme-org' });
    const first = dotBudgetThrottle(CHARTER, { evaluate, alert, now: () => NOW });
    expect(first.throttle).toBe('soft');
    expect(evaluate).toHaveBeenCalledWith(
      { tenant_slug: 'acme', organization_id: 'acme-org' },
      expect.objectContaining({ now: expect.any(Function) })
    );
    dotBudgetThrottle(CHARTER, { evaluate, alert, now: () => new Date(NOW.getTime() + 30_000) });
    expect(evaluate).toHaveBeenCalledTimes(1);
    dotBudgetThrottle(CHARTER, { evaluate, alert, now: () => new Date(NOW.getTime() + 61_000) });
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toMatchObject({ severity: 'warning', category: 'budget' });
  });
});

describe('budget extensions', () => {
  it('are registered in the dot extension registry', () => {
    expect(DOT_FLOOR_CONTRIBUTORS).toContain(DOT_BUDGET_FLOOR_CONTRIBUTOR);
    expect(DOT_STATUS_SECTIONS).toContain(DOT_BUDGET_STATUS_SECTION);
    expect(DOT_DIGEST_SECTIONS).toContain(DOT_BUDGET_DIGEST_SECTION);
    expect(DOT_BUDGET_FLOOR_CONTRIBUTOR.id).toBe('budget-soft');
  });

  it('raise the floor to approve at soft/hard, report status and a digest line', () => {
    const ctx = { now: () => NOW };
    dotBudgetThrottle(CHARTER, {
      evaluate: () => evaluation(400, 'normal'),
      alert: vi.fn(),
      now: () => NOW,
    });
    expect(DOT_BUDGET_FLOOR_CONTRIBUTOR.floor(CHARTER, PROPOSAL, ctx)).toBeUndefined();
    expect(DOT_BUDGET_DIGEST_SECTION.lines(CHARTER, undefined, ctx)).toEqual([
      'Budget: 40% of daily tokens (soft at 80%)',
    ]);
    resetDotBudgetCache();
    dotBudgetThrottle(CHARTER, {
      evaluate: () => evaluation(850, 'soft'),
      alert: vi.fn(),
      now: () => NOW,
    });
    expect(DOT_BUDGET_FLOOR_CONTRIBUTOR.floor(CHARTER, PROPOSAL, ctx)).toBe('approve');
    expect(DOT_BUDGET_STATUS_SECTION.collect(CHARTER, ctx)).toMatchObject({
      throttle: 'soft',
      tokens: 850,
      daily_token_cap: 1000,
      used_pct: 85,
      soft_at_pct: 80,
      hard_at_pct: 100,
    });
    expect(DOT_BUDGET_DIGEST_SECTION.lines(CHARTER, undefined, ctx)[0]).toMatch(
      /^Budget: 85% of daily tokens \(soft at 80%\) — soft throttle/
    );
    resetDotBudgetCache();
    dotBudgetThrottle(CHARTER, {
      evaluate: () => evaluation(1200, 'hard'),
      alert: vi.fn(),
      now: () => NOW,
    });
    expect(DOT_BUDGET_FLOOR_CONTRIBUTOR.floor(CHARTER, PROPOSAL, ctx)).toBe('approve');
  });
});

describe('budget hermeticity', () => {
  it('evaluateDotBudget never alerts; only dotBudgetThrottle (daemon path) does', () => {
    const alert = vi.fn();
    const evaluate = () => evaluation(1200, 'hard');
    expect(evaluateDotBudget(CHARTER, { evaluate, alert, now: () => NOW }).throttle).toBe('hard');
    expect(alert).not.toHaveBeenCalled();
    dotBudgetThrottle(CHARTER, { evaluate, alert, now: () => NOW });
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('the floor contributor, status and digest read only the cache — no alert from the gate', () => {
    const alert = vi.fn();
    evaluateDotBudget(CHARTER, { evaluate: () => evaluation(850, 'soft'), alert, now: () => NOW });
    const ctx = { now: () => NOW };
    expect(DOT_BUDGET_FLOOR_CONTRIBUTOR.floor(CHARTER, PROPOSAL, ctx)).toBe('approve');
    DOT_BUDGET_STATUS_SECTION.collect(CHARTER, ctx);
    DOT_BUDGET_DIGEST_SECTION.lines(CHARTER, undefined, ctx);
    expect(alert).not.toHaveBeenCalled();
  });

  it('setDotBudgetThrottleForTests replaces every read and suppresses alerts', () => {
    const alert = vi.fn();
    const evaluate = vi.fn(() => evaluation(1200, 'hard'));
    setDotBudgetThrottleForTests(() => 'soft');
    expect(dotBudgetThrottle(CHARTER, { evaluate, alert, now: () => NOW }).throttle).toBe('soft');
    expect(DOT_BUDGET_FLOOR_CONTRIBUTOR.floor(CHARTER, PROPOSAL, { now: () => NOW })).toBe(
      'approve'
    );
    setDotBudgetThrottleForTests(() => evaluation(10, 'normal'));
    expect(
      DOT_BUDGET_FLOOR_CONTRIBUTOR.floor(CHARTER, PROPOSAL, { now: () => NOW })
    ).toBeUndefined();
    expect(evaluate).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });
});

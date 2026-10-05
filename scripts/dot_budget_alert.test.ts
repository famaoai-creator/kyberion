import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyDotBudgetStopOnce, resetDotBudgetAlerts } from './dot_budget_alert.js';

describe('dot budget stop alert', () => {
  const notify = vi.fn(() => true);
  const charter = { dot_id: 'org-ops' };

  beforeEach(() => {
    resetDotBudgetAlerts();
    notify.mockClear();
  });

  it('tells the operator once per dot, reason and day', () => {
    const day = new Date('2026-10-05T01:00:00Z');
    expect(notifyDotBudgetStopOnce(charter, 'token-cap', day, notify)).toBe(true);
    expect(
      notifyDotBudgetStopOnce(charter, 'token-cap', new Date('2026-10-05T23:00:00Z'), notify)
    ).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      'ops_alert',
      expect.objectContaining({
        title: 'Dot org-ops paused by budget',
        correlation_id: 'dot-budget-stop:org-ops:token-cap:2026-10-05',
      })
    );
  });

  it('announces a different reason, a different dot and the next day separately', () => {
    const day = new Date('2026-10-05T01:00:00Z');
    notifyDotBudgetStopOnce(charter, 'token-cap', day, notify);
    notifyDotBudgetStopOnce(charter, 'budget-hard', day, notify);
    notifyDotBudgetStopOnce({ dot_id: 'repo-guardian' }, 'token-cap', day, notify);
    notifyDotBudgetStopOnce(charter, 'token-cap', new Date('2026-10-06T01:00:00Z'), notify);
    expect(notify).toHaveBeenCalledTimes(4);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  checkSpendGuard,
  loadSpendPolicy,
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
    expect(spend).toEqual({ daily: 5, mission: 2 });
  });
});

describe('checkSpendGuard', () => {
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

describe('loadSpendPolicy', () => {
  it('loads the governed policy with a warn default posture', () => {
    const policy = loadSpendPolicy();
    expect(policy.posture).toBe('warn');
    expect(policy.daily_cap_usd).toBeGreaterThan(0);
    expect(policy.mission_cap_usd).toBeGreaterThan(0);
  });
});

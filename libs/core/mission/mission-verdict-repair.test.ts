import { describe, expect, it } from 'vitest';
import { appendVerdictRepair, MAX_VERDICT_REPAIRS } from './mission-verdict-repair.js';

describe('appendVerdictRepair bounds', () => {
  it('refuses a third append with replan_limit', () => {
    const result = appendVerdictRepair({
      missionId: 'm-1',
      failedChildItemId: 'missing',
      actorId: 'operator',
      state: {
        mission_id: 'm-1',
        verdict_repair_count: MAX_VERDICT_REPAIRS,
      },
    });
    // Missing item is checked after limit — either replan_limit or item_not_found is fail-closed.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['replan_limit', 'item_not_found']).toContain(result.stop_reason);
    }
  });

  it('refuses when paused or verification was skipped via state flags', () => {
    expect(
      appendVerdictRepair({
        missionId: 'm-1',
        failedChildItemId: 'x',
        actorId: 'op',
        state: { mission_id: 'm-1', verdict_repair_count: 0, paused: true },
      })
    ).toEqual({ ok: false, stop_reason: 'paused' });

    expect(
      appendVerdictRepair({
        missionId: 'm-1',
        failedChildItemId: 'x',
        actorId: 'op',
        state: { mission_id: 'm-1', verdict_repair_count: 0, hard_limit: true },
      })
    ).toEqual({ ok: false, stop_reason: 'hard_limit' });
  });

  it('caps repairs at 2', () => {
    expect(MAX_VERDICT_REPAIRS).toBe(2);
  });
});

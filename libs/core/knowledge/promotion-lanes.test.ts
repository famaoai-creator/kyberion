import { describe, expect, it } from 'vitest';
import {
  resolvePromotionLane,
  autoLaneEligible,
  laneApprovesWithoutSteward,
} from './promotion-lanes.js';

describe('promotion-lanes', () => {
  it('knowledge_hint travels the auto lane; sop/report_template need pr_review', () => {
    expect(resolvePromotionLane({ target_kind: 'knowledge_hint', tier: 'public' })).toBe('auto');
    expect(resolvePromotionLane({ target_kind: 'sop_candidate', tier: 'public' })).toBe(
      'pr_review'
    );
    expect(resolvePromotionLane({ target_kind: 'report_template', tier: 'public' })).toBe(
      'pr_review'
    );
  });

  it('sensitive tiers and security-flavored content always need steward', () => {
    expect(resolvePromotionLane({ target_kind: 'knowledge_hint', tier: 'confidential' })).toBe(
      'steward'
    );
    expect(
      resolvePromotionLane({ target_kind: 'knowledge_hint', title: 'update security policy' })
    ).toBe('steward');
  });

  it('evidence-gated kinds approve only past the recurrence bar', () => {
    const c = { target_kind: 'pattern', tier: 'public', title: 'p' };
    expect(laneApprovesWithoutSteward(c, 2).approves).toBe(false);
    expect(laneApprovesWithoutSteward(c, 3).approves).toBe(true);
  });

  it('auto lane downgrades to steward when guards fail', () => {
    const c = {
      target_kind: 'knowledge_hint',
      tier: 'public',
      summary: 'store the api_key in env',
    };
    const r = laneApprovesWithoutSteward(c, 1);
    expect(r.lane).toBe('steward');
    expect(r.approves).toBe(false);
  });

  it('auto-guard passes clean hints', () => {
    expect(
      autoLaneEligible({ target_kind: 'knowledge_hint', tier: 'public', summary: 'retry cadence' })
        .eligible
    ).toBe(true);
  });
});

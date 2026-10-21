import { describe, expect, it } from 'vitest';
import { DEFAULT_DECISION_AUTHORITY_POLICY, loadDecisionAuthorityPolicy } from './policy.js';
import { canActorDecideLevel, promoteDecision } from './promote.js';
import type { DecisionRecord } from './model.js';

describe('decision authority policy', () => {
  it('ships a governed catalog that mirrors the in-code default', () => {
    const loaded = loadDecisionAuthorityPolicy();
    expect(loaded.levels).toEqual(DEFAULT_DECISION_AUTHORITY_POLICY.levels);
    expect(loaded.basis_required_for_decided).toBe(
      DEFAULT_DECISION_AUTHORITY_POLICY.basis_required_for_decided
    );
  });

  it('drives who may decide: a tenant can widen product levels to viewers through policy alone', () => {
    const viewer = { kind: 'human' as const, id: 'user:vic', role: 'viewer' as const };
    expect(canActorDecideLevel('product-fixed', viewer)).toEqual({
      ok: false,
      reason: 'role_cannot_decide',
    });
    const widened = {
      ...DEFAULT_DECISION_AUTHORITY_POLICY,
      levels: {
        ...DEFAULT_DECISION_AUTHORITY_POLICY.levels,
        'product-fixed': { deciding_roles: ['owner', 'approver', 'viewer'] as const },
      },
    };
    expect(canActorDecideLevel('product-fixed', viewer, [], widened)).toEqual({ ok: true });
  });

  it('lets policy drop the basis requirement and the options requirement', () => {
    const owner = { kind: 'human' as const, id: 'user:alice', role: 'owner' as const };
    const axis: DecisionRecord = {
      id: 'D-0001',
      case_id: 'c',
      item: 'I',
      key: 'k.a',
      level: 'product-axis',
      state: 'proposed',
      value: null,
      options: [],
      basis: [],
      origin: 'facade',
      status: 'active',
    };
    expect(promoteDecision({ decision: axis, decidedBy: owner, now: 'n' })).toMatchObject({
      outcome: 'proposed',
      reason: 'axis_without_options',
    });
    const relaxed = {
      ...DEFAULT_DECISION_AUTHORITY_POLICY,
      basis_required_for_decided: false,
      levels: {
        ...DEFAULT_DECISION_AUTHORITY_POLICY.levels,
        'product-axis': { deciding_roles: ['owner'] as const, requires_options: false },
      },
    };
    expect(
      promoteDecision({ decision: axis, decidedBy: owner, now: 'n', policy: relaxed }).outcome
    ).toBe('decided');
  });
});

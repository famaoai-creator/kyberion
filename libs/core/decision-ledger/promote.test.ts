import { describe, expect, it } from 'vitest';
import { canActorDecideLevel, promoteDecision } from './promote.js';
import type { DecisionCustomerActor, DecisionDecidedBy, DecisionRecord } from './model.js';

const NOW = '2026-09-14T00:00:00.000Z';

function proposed(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: 'D-0001',
    case_id: 'case-a',
    item: 'SCR-1#B1',
    key: 'csv.columns',
    level: 'product-fixed',
    state: 'proposed',
    value: ['a', 'b'],
    basis: [{ ref: 'QA-1', version: 'r1' }],
    origin: 'facade',
    status: 'active',
    ...overrides,
  };
}

const owner: DecisionDecidedBy = { kind: 'human', id: 'user:alice', role: 'owner' };
const viewer: DecisionDecidedBy = { kind: 'human', id: 'user:vic', role: 'viewer' };
const customerActors: DecisionCustomerActor[] = [
  {
    id: 'customer:bank-a',
    name: 'Bank A',
    decides: ['customer-value'],
    confirm_target: 'CT-bank-a',
  },
  { id: 'customer:vendor-x', name: 'Vendor X', decides: [] },
];

describe('canActorDecideLevel', () => {
  it('lets an owner/approver decide product levels and refuses a viewer', () => {
    expect(canActorDecideLevel('product-fixed', owner)).toEqual({ ok: true });
    expect(canActorDecideLevel('product-axis', { ...owner, role: 'approver' })).toEqual({
      ok: true,
    });
    expect(canActorDecideLevel('product-fixed', viewer)).toEqual({
      ok: false,
      reason: 'role_cannot_decide',
    });
  });

  it('never decides an undecided level directly', () => {
    expect(canActorDecideLevel('undecided', owner)).toEqual({
      ok: false,
      reason: 'level_undecided',
    });
  });

  it('records customer values only on behalf of a registered, entitled actor with evidence', () => {
    expect(canActorDecideLevel('customer-value', owner, customerActors)).toEqual({
      ok: false,
      reason: 'customer_actor_required',
    });
    expect(
      canActorDecideLevel(
        'customer-value',
        { ...owner, on_behalf_of: { actor_id: 'customer:nobody' } },
        customerActors
      )
    ).toEqual({ ok: false, reason: 'customer_actor_unknown' });
    expect(
      canActorDecideLevel(
        'customer-value',
        { ...owner, on_behalf_of: { actor_id: 'customer:vendor-x', evidence: 'x' } },
        customerActors
      )
    ).toEqual({ ok: false, reason: 'customer_actor_not_entitled' });
    expect(
      canActorDecideLevel(
        'customer-value',
        { ...owner, on_behalf_of: { actor_id: 'customer:bank-a' } },
        customerActors
      )
    ).toEqual({ ok: false, reason: 'customer_approval_required', ask: 'CT-bank-a' });
    expect(
      canActorDecideLevel(
        'customer-value',
        {
          ...owner,
          on_behalf_of: { actor_id: 'customer:bank-a', evidence: 'minutes-2026-09-14#3' },
        },
        customerActors
      )
    ).toEqual({ ok: true });
  });
});

describe('promoteDecision', () => {
  it('promotes a product-fixed proposal to decided with the deciding member and time', () => {
    const result = promoteDecision({ decision: proposed(), decidedBy: owner, now: NOW });
    expect(result.outcome).toBe('decided');
    expect(result.decision.state).toBe('decided');
    expect(result.decision.decided_at).toBe(NOW);
    expect(result.decision.decided_by).toEqual(owner);
    expect(result.decision.pending_reason).toBeUndefined();
  });

  it('keeps an axis without options as proposed and names the reason', () => {
    const result = promoteDecision({
      decision: proposed({ level: 'product-axis', options: [] }),
      decidedBy: owner,
      now: NOW,
    });
    expect(result).toMatchObject({ outcome: 'proposed', reason: 'axis_without_options' });
    expect(result.decision.state).toBe('proposed');
    expect(result.decision.pending_reason).toBe('axis_without_options');
  });

  it('keeps a customer value as proposed until the customer approves, and says who to ask', () => {
    const result = promoteDecision({
      decision: proposed({ level: 'customer-value' }),
      decidedBy: { ...owner, on_behalf_of: { actor_id: 'customer:bank-a' } },
      now: NOW,
      customerActors,
    });
    expect(result).toMatchObject({
      outcome: 'proposed',
      reason: 'customer_approval_required',
      ask: 'CT-bank-a',
    });
  });

  it('refuses a decision without basis', () => {
    const result = promoteDecision({
      decision: proposed({ basis: [] }),
      decidedBy: owner,
      now: NOW,
    });
    expect(result).toMatchObject({ outcome: 'proposed', reason: 'basis_required' });
  });

  it('throws for a non-human decider — a machine is never recorded as deciding', () => {
    expect(() =>
      promoteDecision({
        decision: proposed(),
        decidedBy: {
          kind: 'agent',
          id: 'kyberion://agent/org/bot',
        } as unknown as DecisionDecidedBy,
        now: NOW,
      })
    ).toThrow(/requires a human actor/u);
  });
});

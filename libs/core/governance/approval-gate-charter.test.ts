import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentActor } from '../actor.js';
import type { Charter, CharterAction, CharterDecision } from './accountability-charter.js';

vi.mock('./approval-policy.js', () => ({ resolveApprovalPolicy: vi.fn() }));
vi.mock('./audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('./governance-action-recorder.js', () => ({ recordGovernanceAction: vi.fn() }));
vi.mock('../surface/operator-notifications.js', () => ({ notifyOperator: vi.fn() }));
vi.mock('./accountability-charter-registry.js', () => ({
  evaluateUnderCharter: vi.fn(),
  recordCharterConsumption: vi.fn(),
  recordCharterDenial: vi.fn(),
}));

import { isCharterEligiblePolicy, runCharterGate } from './approval-gate-charter.js';
import { resolveApprovalPolicy } from './approval-policy.js';
import { auditChain } from './audit-chain.js';
import { notifyOperator } from '../surface/operator-notifications.js';
import {
  evaluateUnderCharter,
  recordCharterConsumption,
  recordCharterDenial,
} from './accountability-charter-registry.js';

const policy = vi.mocked(resolveApprovalPolicy);
const evaluate = vi.mocked(evaluateUnderCharter);
const consume = vi.mocked(recordCharterConsumption);
const deny = vi.mocked(recordCharterDenial);
const audit = vi.mocked(auditChain.record);
const notify = vi.mocked(notifyOperator);

const CHARTER = { charter_id: 'chr-acme-1' } as Charter;
const ACTION: CharterAction = {
  actor: agentActor('kyberion://agent/acme/worker', 'user:owner'),
  action_class: 'payment',
  amount: 1000,
  reversible: true,
};
const decision = (over: Partial<CharterDecision>): CharterDecision => ({
  decision: 'allow',
  reasons: ['within_charter'],
  consumption: { money: 1000, loss: 0 },
  responsible: 'user:owner',
  charter_id: 'chr-acme-1',
  ...over,
});
const run = () =>
  runCharterGate({
    charter: { scope: { kind: 'organization', tenant_slug: 'acme' }, action: ACTION },
    agentId: 'agent-1',
    operationId: 'payment:send',
    intentId: 'pay',
    correlationId: 'corr-1',
    now: new Date('2026-10-01T00:00:00.000Z'),
  });

describe('isCharterEligiblePolicy', () => {
  it('lets a charter carry ordinary policy rules', () => {
    expect(
      isCharterEligiblePolicy({
        requiresApproval: true,
        missingRequirements: ['approval_confirmation'],
        matchedRuleId: 'send-email',
      })
    ).toBe(true);
    expect(isCharterEligiblePolicy({ requiresApproval: false, missingRequirements: [] })).toBe(
      true
    );
  });
  it('never carries hardened or hard-coded dangerous policies', () => {
    for (const matchedRuleId of [
      'injection-suspected-override',
      'strict-posture-floor',
      'fallback-dangerous-shell',
      'fallback-dangerous-egress',
      'fallback-dangerous-secret',
      'fallback-dangerous-deploy',
    ]) {
      expect(
        isCharterEligiblePolicy({ requiresApproval: true, missingRequirements: [], matchedRuleId })
      ).toBe(false);
    }
    expect(
      isCharterEligiblePolicy({
        requiresApproval: true,
        missingRequirements: ['dual_key_confirmation'],
        matchedRuleId: 'x',
      })
    ).toBe(false);
  });
});

describe('runCharterGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    policy.mockReturnValue({
      requiresApproval: true,
      missingRequirements: ['approval_confirmation'],
      matchedRuleId: 'send-money',
    });
  });

  it('no active charter → none, nothing recorded (legacy gate runs)', () => {
    evaluate.mockReturnValue(null);
    expect(run()).toEqual({ kind: 'none' });
    expect(consume).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('inside the charter → allow, consumption recorded once with the correlation id, audited against the responsible human', () => {
    evaluate.mockReturnValue({ charter: CHARTER, decision: decision({}) });
    const out = run();
    expect(out.kind).toBe('allow');
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0][5]).toBe('corr-1');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'allowed',
        metadata: expect.objectContaining({
          charter_id: 'chr-acme-1',
          responsible: 'user:owner',
          on_behalf_of: 'user:owner',
        }),
      })
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it('near the budget edge → allow and notify', () => {
    evaluate.mockReturnValue({
      charter: CHARTER,
      decision: decision({
        decision: 'allow_notify',
        reasons: ['within_charter', 'budget_near_limit'],
      }),
    });
    expect(run().kind).toBe('allow');
    expect(notify).toHaveBeenCalledWith(
      'decision_digest',
      expect.objectContaining({ title: expect.stringContaining('near its limit') })
    );
  });

  it('inside the envelope but a hardened policy applies → a human still decides, and no budget is consumed', () => {
    evaluate.mockReturnValue({ charter: CHARTER, decision: decision({}) });
    policy.mockReturnValue({
      requiresApproval: true,
      missingRequirements: ['dual_key_confirmation'],
      matchedRuleId: 'fallback-dangerous-secret',
    });
    const out = run();
    expect(out.kind).toBe('require_approval');
    expect(consume).not.toHaveBeenCalled();
  });

  it('outside the charter → require_approval, the denial and its amendment are recorded', () => {
    evaluate.mockReturnValue({
      charter: CHARTER,
      decision: decision({
        decision: 'deny',
        reasons: ['money.per_action exceeded'],
        consumption: { money: 0, loss: 0 },
        amendment: {
          field: 'envelope.money.per_action',
          current: 100,
          requested: 1000,
          reason: 'x',
        },
      }),
    });
    expect(run()).toEqual({ kind: 'require_approval', reason: 'money.per_action exceeded' });
    expect(deny).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'denied',
        metadata: expect.objectContaining({
          amendment: expect.objectContaining({ field: 'envelope.money.per_action' }),
        }),
      })
    );
  });

  it('tripwire → stop, a hard block that names who can clear it', () => {
    evaluate.mockReturnValue({
      charter: CHARTER,
      decision: decision({ decision: 'stop', reasons: ['tripwire:audit-chain-gap'] }),
    });
    const out = run();
    expect(out).toMatchObject({ kind: 'stop', message: expect.stringContaining('[CHARTER_STOP]') });
    expect(consume).not.toHaveBeenCalled();
  });
});

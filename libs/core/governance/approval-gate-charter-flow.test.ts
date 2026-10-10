import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentActor } from '../actor.js';

vi.mock('./approval-policy.js', () => ({ resolveApprovalPolicy: vi.fn() }));
vi.mock('../decision-rights.js', () => ({
  resolveDecisionRightsMatrix: vi.fn(() => null),
  evaluateDecisionRights: vi.fn(() => null),
}));
import { evaluateDecisionRights } from '../decision-rights.js';
vi.mock('./approval-store.js', async (importOriginal) => ({
  isApprovalRequestExpired: (await importOriginal<typeof import('./approval-store.js')>())
    .isApprovalRequestExpired,
  expireApprovalRequest: vi.fn(),
  createApprovalRequest: vi.fn(),
  listApprovalRequests: vi.fn(() => []),
  lookupSessionApprovalCache: vi.fn(() => null),
  recordSessionCacheAutoApproval: vi.fn(),
  computeApprovalPayloadHash: (p: Record<string, unknown> | undefined) => JSON.stringify(p || {}),
}));
vi.mock('./audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('./approval-gate-charter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./approval-gate-charter.js')>()),
  runCharterGate: vi.fn(),
}));

import { enforceApprovalGate } from './approval-gate.js';
import { resolveApprovalPolicy } from './approval-policy.js';
import { createApprovalRequest } from './approval-store.js';
import { runCharterGate } from './approval-gate-charter.js';

const charterGate = vi.mocked(runCharterGate);
const policy = vi.mocked(resolveApprovalPolicy);
const create = vi.mocked(createApprovalRequest);

const params = {
  operationId: 'payment:send',
  agentId: 'agent-1',
  correlationId: 'corr-1',
  channel: 'terminal',
  charter: {
    scope: { kind: 'organization' as const, tenant_slug: 'acme' },
    action: {
      actor: agentActor('kyberion://agent/acme/worker', 'user:owner'),
      action_class: 'payment',
      reversible: true,
    },
  },
};

describe('enforceApprovalGate × accountability charter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    policy.mockReturnValue({
      requiresApproval: true,
      missingRequirements: ['approval_confirmation'],
    });
  });

  it('without params.charter the charter branch is never consulted (legacy behavior)', () => {
    policy.mockReturnValue({ requiresApproval: false, missingRequirements: [] });
    const { charter: _omit, ...legacy } = params;
    void _omit;
    expect(enforceApprovalGate(legacy).allowed).toBe(true);
    expect(charterGate).not.toHaveBeenCalled();
  });

  it('tells the charter branch whether the decision-rights matrix escalates this decision', () => {
    charterGate.mockReturnValue({ kind: 'none' });
    policy.mockReturnValue({ requiresApproval: false, missingRequirements: [] });
    vi.mocked(evaluateDecisionRights).mockReturnValueOnce({ requiresEscalation: true } as never);
    enforceApprovalGate({ ...params, payload: { decision_type: 'operational_spend', amount: 1 } });
    expect(charterGate.mock.calls[0][0]).toMatchObject({ decisionRightsEscalates: true });
    vi.mocked(evaluateDecisionRights).mockReturnValueOnce(null);
    enforceApprovalGate({ ...params, correlationId: 'corr-2' });
    expect(charterGate.mock.calls[1][0]).toMatchObject({ decisionRightsEscalates: false });
  });

  it('a charter may stand in only for a human-acceptance escalation the matrix marks delegable', () => {
    charterGate.mockReturnValue({ kind: 'none' });
    policy.mockReturnValue({ requiresApproval: false, missingRequirements: [] });
    const cases = [
      [{ escalationKind: 'human_acceptance', charterDelegable: true }, true],
      [{ escalationKind: 'human_acceptance', charterDelegable: false }, false],
      [{ escalationKind: 'over_threshold', charterDelegable: true }, false],
      [{ escalationKind: 'role_mismatch', charterDelegable: true }, false],
    ] as const;
    cases.forEach(([evaluation, expected], i) => {
      vi.mocked(evaluateDecisionRights).mockReturnValueOnce({
        requiresEscalation: true,
        ...evaluation,
      } as never);
      enforceApprovalGate({ ...params, correlationId: `corr-d${i}` });
      expect(charterGate.mock.calls[i][0]).toMatchObject({
        decisionRightsCharterDelegable: expected,
      });
    });
  });

  it('inside the charter: allowed without any approval request', () => {
    charterGate.mockReturnValue({ kind: 'allow', message: 'Within accountability charter chr-1' });
    const r = enforceApprovalGate(params);
    expect(r).toMatchObject({ allowed: true, status: 'not_required' });
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['ordinary-policy', 'injection-suspected-override'])(
    'a charter allow cannot waive a mandatory floor carried by %s',
    (matchedRuleId) => {
      policy.mockReturnValue({
        requiresApproval: true,
        missingRequirements: ['approval_confirmation'],
        matchedRuleId,
        mandatoryApproval: true,
      });
      charterGate.mockReturnValue({ kind: 'allow', message: 'Within charter' });

      expect(enforceApprovalGate({ ...params, hasHuman: false })).toMatchObject({
        allowed: false,
        message: expect.stringContaining('[HUMAN_REQUIRED]'),
      });
    }
  );

  it('tripwire: blocked, and no approval request is opened (a human must clear the stop)', () => {
    charterGate.mockReturnValue({ kind: 'stop', message: '[CHARTER_STOP] tripwire:x' });
    const r = enforceApprovalGate(params);
    expect(r).toMatchObject({ allowed: false, message: expect.stringContaining('[CHARTER_STOP]') });
    expect(create).not.toHaveBeenCalled();
  });

  it('outside the charter tightens: even when the legacy policy needs no approval, a human is required', () => {
    policy.mockReturnValue({ requiresApproval: false, missingRequirements: [] });
    charterGate.mockReturnValue({ kind: 'none' });
    expect(enforceApprovalGate(params).allowed).toBe(true); // no charter for this scope: legacy
    charterGate.mockReturnValue({ kind: 'require_approval', reason: 'money.per_action exceeded' });
    const r = enforceApprovalGate({ ...params, hasHuman: false });
    expect(r.allowed).toBe(false);
    expect(r.message).toContain('[HUMAN_REQUIRED]');
  });
});

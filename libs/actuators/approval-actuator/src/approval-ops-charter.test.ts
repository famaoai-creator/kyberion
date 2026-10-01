import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enforceApprovalGate: vi.fn(),
  charterInputForDecision: vi.fn(),
  resolveDecisionRightsMatrix: vi.fn(() => ({})),
  evaluateDecisionRights: vi.fn(),
}));

vi.mock('@agent/core/governance/approval-gate', () => ({
  enforceApprovalGate: mocks.enforceApprovalGate,
}));
vi.mock('@agent/core/governance/charter-call-site', () => ({
  charterInputForDecision: mocks.charterInputForDecision,
}));
vi.mock('@agent/core/decision-rights', () => ({
  resolveDecisionRightsMatrix: mocks.resolveDecisionRightsMatrix,
  evaluateDecisionRights: mocks.evaluateDecisionRights,
}));

import { evaluateDecisionRightsOp } from './approval-ops.js';

const input = {
  operation_id: 'spend.vendor',
  correlation_id: 'corr-1',
  decision_type: 'operational_spend',
  amount: 40_000,
  tenant_slug: 'acme',
  agent_id: 'mission_controller',
};
const CHARTER = { scope: { kind: 'organization', tenant_slug: 'acme' }, action: {} };

describe('evaluateDecisionRightsOp × accountability charter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enforceApprovalGate.mockReturnValue({ allowed: true, status: 'not_required' });
  });

  it('no charter + rights need no escalation → legacy early return, the gate is never called', () => {
    mocks.evaluateDecisionRights.mockReturnValue({ requiresEscalation: false });
    mocks.charterInputForDecision.mockReturnValue(undefined);
    expect(evaluateDecisionRightsOp(input)).toEqual({ allowed: true, status: 'not_required' });
    expect(mocks.enforceApprovalGate).not.toHaveBeenCalled();
  });

  it('an active charter reaches the gate even when rights need no escalation (the charter is a limit as well as a grant)', () => {
    mocks.evaluateDecisionRights.mockReturnValue({ requiresEscalation: false });
    mocks.charterInputForDecision.mockReturnValue(CHARTER);
    evaluateDecisionRightsOp(input);
    expect(mocks.enforceApprovalGate).toHaveBeenCalledTimes(1);
    expect(mocks.enforceApprovalGate.mock.calls[0][0]).toMatchObject({
      charter: CHARTER,
      operationId: 'spend.vendor',
    });
    expect(mocks.charterInputForDecision).toHaveBeenCalledWith({
      tenantSlug: 'acme',
      agentId: 'mission_controller',
      decisionType: 'operational_spend',
      amount: 40_000,
    });
  });

  it('rights escalation without a charter still goes to the gate exactly as before, with no charter key', () => {
    mocks.evaluateDecisionRights.mockReturnValue({ requiresEscalation: true });
    mocks.charterInputForDecision.mockReturnValue(undefined);
    evaluateDecisionRightsOp(input);
    expect(mocks.enforceApprovalGate.mock.calls[0][0]).not.toHaveProperty('charter');
  });

  it('surfaces the gate result (pending human approval outside the charter)', () => {
    mocks.evaluateDecisionRights.mockReturnValue({ requiresEscalation: false });
    mocks.charterInputForDecision.mockReturnValue(CHARTER);
    mocks.enforceApprovalGate.mockReturnValue({
      allowed: false,
      status: 'pending',
      requestId: 'req-9',
      message: 'needs a human',
    });
    expect(evaluateDecisionRightsOp(input)).toEqual({
      allowed: false,
      status: 'pending',
      request_id: 'req-9',
      message: 'needs a human',
    });
  });
});

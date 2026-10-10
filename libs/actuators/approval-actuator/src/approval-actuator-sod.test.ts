import { beforeEach, describe, expect, it, vi } from 'vitest';

const decide = vi.hoisted(() => vi.fn((_role: unknown, params: Record<string, unknown>) => params));
const load = vi.hoisted(() => vi.fn((): unknown => null));

vi.mock('@agent/core/governance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/governance')>()),
  decideApprovalRequest: decide,
  loadApprovalRequest: load,
}));

import { handleApprovalAction } from './approval-actuator-helpers.js';

const REQUEST_ID = '123e4567-e89b-12d3-a456-426614174000';

function decideAsHuman(decision: 'approved' | 'rejected' = 'approved') {
  return handleApprovalAction({
    action: 'decide',
    params: {
      channel: 'terminal',
      requestId: REQUEST_ID,
      decision,
      decidedBy: 'alice',
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'passkey',
    },
  });
}

describe('approval-actuator decide: decider identity', () => {
  beforeEach(() => {
    decide.mockClear();
    load.mockReset();
    load.mockReturnValue(null);
  });

  it('marks the ADF-supplied decider as caller_supplied so separation of duties can refuse it', async () => {
    await decideAsHuman();
    expect(decide).toHaveBeenCalledWith(
      'mission_controller',
      expect.objectContaining({ decidedBy: 'alice', deciderIdentitySource: 'caller_supplied' })
    );
  });

  it('HA-02: records the decision as an agent decision whatever the ADF claims', async () => {
    load.mockReturnValue({ id: REQUEST_ID, status: 'pending' });
    await decideAsHuman();
    const params = decide.mock.calls[0][1];
    expect(params).toMatchObject({ decidedByType: 'ai_agent', authenticated: false });
    expect(params.authMethod).toBeUndefined();
  });

  it('HA-02: refuses a human-only request with [APPROVAL_HUMAN_PROOF_REQUIRED]', async () => {
    load.mockReturnValue({
      id: REQUEST_ID,
      status: 'pending',
      accountability: { finalDecision: 'human_only' },
    });
    for (const decision of ['approved', 'rejected'] as const) {
      await expect(decideAsHuman(decision)).rejects.toThrow('[APPROVAL_HUMAN_PROOF_REQUIRED]');
    }
    expect(decide).not.toHaveBeenCalled();
  });
});

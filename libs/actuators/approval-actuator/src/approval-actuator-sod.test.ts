import { describe, expect, it, vi } from 'vitest';

const decide = vi.hoisted(() => vi.fn((_role: unknown, params: Record<string, unknown>) => params));

vi.mock('@agent/core/governance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/governance')>()),
  decideApprovalRequest: decide,
}));

import { handleApprovalAction } from './approval-actuator-helpers.js';

describe('approval-actuator decide: decider identity', () => {
  it('marks the ADF-supplied decider as caller_supplied so separation of duties can refuse it', async () => {
    await handleApprovalAction({
      action: 'decide',
      params: {
        channel: 'terminal',
        requestId: '123e4567-e89b-12d3-a456-426614174000',
        decision: 'approved',
        decidedBy: 'alice',
        decidedByType: 'human',
        authenticated: true,
      },
    });
    expect(decide).toHaveBeenCalledWith(
      'mission_controller',
      expect.objectContaining({ decidedBy: 'alice', deciderIdentitySource: 'caller_supplied' })
    );
  });
});

import { describe, expect, it } from 'vitest';
import { loadApprovalPolicy, resolveApprovalPolicy } from './approval-policy.js';

describe('approval-policy', () => {
  it('loads knowledge-owned approval rules', () => {
    const policy = loadApprovalPolicy();
    expect(policy.rules?.length || 0).toBeGreaterThan(0);
  });

  it('requires approval for mutating service operations and not for passive ones', () => {
    const restart = resolveApprovalPolicy({
      intentId: 'inspect-service',
      payload: { operation: 'restart' },
    });
    const logs = resolveApprovalPolicy({
      intentId: 'inspect-service',
      payload: { operation: 'logs' },
    });
    expect(restart.requiresApproval).toBe(true);
    expect(restart.missingRequirements).toContain('approval_confirmation');
    expect(logs.requiresApproval).toBe(false);
  });
});

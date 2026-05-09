import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { safeWriteFile } from './secure-io.js';
import { loadApprovalPolicy, resolveApprovalPolicy } from './approval-policy.js';
import { pathResolver } from './path-resolver.js';

const mocks = vi.hoisted(() => ({
  customerRoot: vi.fn(() => null as string | null),
}));

vi.mock('./customer-resolver.js', () => ({
  customerRoot: mocks.customerRoot,
}));

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

  it('prefers a customer policy overlay when one is active', async () => {
    const customerPolicyPath = pathResolver.sharedTmp(`customer-policy-${Date.now()}.json`);
    safeWriteFile(customerPolicyPath, JSON.stringify({
      defaults: { requires_approval: false },
      rules: [
        {
          id: 'customer-override',
          intent_ids: ['inspect-service'],
          when: { payload_field: 'operation', any_of: ['restart'] },
          requires_approval: false,
          missing_requirements: [],
        },
      ],
    }, null, 2));

    mocks.customerRoot.mockReturnValue(customerPolicyPath);
    vi.resetModules();
    const mod = await import('./approval-policy.js');
    const result = mod.resolveApprovalPolicy({
      intentId: 'inspect-service',
      payload: { operation: 'restart' },
    });
    expect(result.requiresApproval).toBe(false);
    expect(result.matchedRuleId).toBe('customer-override');
  });
});

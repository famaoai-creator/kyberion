import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertOperationPolicy,
  childDelegationEnv,
  currentDelegationDepth,
} from './operation-policy-gate.js';
import { auditChain } from './audit-chain.js';
import { withExecutionContextAsync } from './authority.js';
import { policyEngine } from './policy-engine.js';

vi.mock('./audit-chain.js', () => ({
  auditChain: { record: vi.fn() },
}));

describe('operation-policy-gate (SA-05)', () => {
  const savedDepth = process.env.KYBERION_DELEGATION_DEPTH;
  const savedRing = process.env.KYBERION_AGENT_RING;

  beforeEach(() => {
    vi.mocked(auditChain.record).mockClear();
    delete process.env.KYBERION_DELEGATION_DEPTH;
    delete process.env.KYBERION_AGENT_RING;
  });

  afterEach(() => {
    if (savedDepth === undefined) delete process.env.KYBERION_DELEGATION_DEPTH;
    else process.env.KYBERION_DELEGATION_DEPTH = savedDepth;
    if (savedRing === undefined) delete process.env.KYBERION_AGENT_RING;
    else process.env.KYBERION_AGENT_RING = savedRing;
  });

  it('allows operations no rule targets (policy default)', () => {
    const decision = assertOperationPolicy({
      operation: 'network_request',
      message: 'Fetch example.com',
      context: { hostname: 'example.com' },
    });
    expect(decision.allowed).toBe(true);
    expect(auditChain.record).not.toHaveBeenCalled();
  });

  it('denies delegation chains deeper than the governed limit and audits', () => {
    expect(() =>
      assertOperationPolicy({
        operation: 'reasoning_delegation',
        context: { delegation_depth: 5 },
      })
    ).toThrow('[POLICY_BLOCKED]');
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'policy_violation', operation: 'reasoning_delegation' })
    );
  });

  it('evaluates with the execution-scope persona, not the process env (B2)', async () => {
    const saved = process.env.KYBERION_PERSONA;
    process.env.KYBERION_PERSONA = 'worker';
    const evaluate = vi.spyOn(policyEngine, 'evaluate');
    try {
      await withExecutionContextAsync(
        'mission_controller',
        async () => {
          await Promise.resolve();
          assertOperationPolicy({ operation: 'network_request', context: {} });
        },
        'analyst'
      );
      expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'analyst' }));
    } finally {
      evaluate.mockRestore();
      if (saved === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = saved;
    }
  });

  it('allows delegation within the depth limit', () => {
    const decision = assertOperationPolicy({
      operation: 'reasoning_delegation',
      context: { delegation_depth: 1 },
    });
    expect(decision.allowed).toBe(true);
  });

  it('picks up the agent ring from the environment (ring3 read-only fires)', () => {
    process.env.KYBERION_AGENT_RING = '3';
    expect(() => assertOperationPolicy({ operation: 'execute_command' })).toThrow(
      '[POLICY_BLOCKED]'
    );
  });

  it('tracks delegation depth through the environment', () => {
    expect(currentDelegationDepth()).toBe(0);
    expect(childDelegationEnv()).toEqual({ KYBERION_DELEGATION_DEPTH: '1' });

    process.env.KYBERION_DELEGATION_DEPTH = '2';
    expect(currentDelegationDepth()).toBe(2);
    expect(childDelegationEnv()).toEqual({ KYBERION_DELEGATION_DEPTH: '3' });

    process.env.KYBERION_DELEGATION_DEPTH = 'garbage';
    expect(currentDelegationDepth()).toBe(0);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';

import { resetEgressPolicyCache, evaluateEgressPolicy } from './egress-policy.js';

describe('egress-policy', () => {
  beforeEach(() => {
    resetEgressPolicyCache();
    delete process.env.KYBERION_EGRESS_POLICY_PATH;
    delete process.env.KYBERION_EGRESS_POLICY;
  });

  it('allows allowlisted service domains derived from orchestration endpoints', () => {
    const decision = evaluateEgressPolicy('https://api.github.com/test');
    expect(decision.verdict).toBe('allow');
    expect(decision.hostname).toBe('api.github.com');
  });

  it('warns on unknown domains when mode is warn', () => {
    const decision = evaluateEgressPolicy('https://unknown.example.com/test');
    expect(decision.verdict).toBe('warn');
  });
});

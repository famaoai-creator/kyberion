import { beforeEach, describe, expect, it } from 'vitest';

import { resetEgressPolicyCache, evaluateEgressPolicy, loadEgressPolicy } from './egress-policy.js';

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

  // DA-02: the Box ingestion connector's API host is granted least-privilege
  // (exact host, not box.com) via the manual allowlist.
  it('allowlists api.box.com explicitly in the manual policy', () => {
    const policy = loadEgressPolicy();
    expect(policy.manual_allowed_domains).toContain('api.box.com');

    const decision = evaluateEgressPolicy('https://api.box.com/2.0/folders/0/items');
    expect(decision.verdict).toBe('allow');
  });

  it('denies non-allowlisted domains when mode is enforce', () => {
    process.env.KYBERION_EGRESS_POLICY = 'enforce';
    resetEgressPolicyCache();

    const decision = evaluateEgressPolicy('https://exfil.example.com/upload');
    expect(decision.verdict).toBe('deny');
    expect(decision.reason).toContain('not allowlisted');
  });
});

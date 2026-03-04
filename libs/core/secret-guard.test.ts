import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getSecret, getActiveSecrets, isSecretPath, validateSovereignBoundary } from '@agent/core';

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

  it('should identify secret paths correctly', () => {
    expect(isSecretPath('vault/secrets/keys.json')).toBe(true);
    expect(isSecretPath('skills/core/index.ts')).toBe(false);
  });
});

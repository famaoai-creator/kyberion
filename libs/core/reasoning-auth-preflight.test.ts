import { describe, expect, it } from 'vitest';
import {
  checkAllReasoningBackendAuth,
  checkReasoningBackendAuth,
} from './reasoning-auth-preflight.js';

describe('reasoning auth preflight', () => {
  it('checks environment credential presence without exposing values', () => {
    const missing = checkReasoningBackendAuth('anthropic', {});
    expect(missing.status).toBe('missing');
    expect(missing.missing_environment).toContain('ANTHROPIC_API_KEY');
    expect(JSON.stringify(missing)).not.toContain('secret');

    const configured = checkReasoningBackendAuth('anthropic', {
      ANTHROPIC_API_KEY: 'secret-value',
    });
    expect(configured.status).toBe('configured');
    expect(JSON.stringify(configured)).not.toContain('secret-value');
  });

  it('separates CLI-managed auth from environment credential checks', () => {
    const result = checkReasoningBackendAuth('codex-cli', {});
    expect(result.status).toBe('cli-managed');
    expect(result.credential_source).toBe('cli');
    expect(result.note).not.toContain('secret-value');
  });

  it('reports all governed modes without making a network call', () => {
    const results = checkAllReasoningBackendAuth({});
    expect(results.some((entry) => entry.mode === 'stub')).toBe(true);
    expect(
      results.every((entry) => entry.required_environment.every((name) => !name.includes('=')))
    ).toBe(true);
  });
});

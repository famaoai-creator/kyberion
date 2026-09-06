import { describe, expect, it, vi } from 'vitest';
import {
  checkAllReasoningBackendAuth,
  checkReasoningBackendAuth,
  probeReasoningBackendAuth,
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

  it('separates configured presence from provider verification', async () => {
    const probe = vi.fn(async () => ({ available: true }));
    const result = await probeReasoningBackendAuth(
      'anthropic',
      { ANTHROPIC_API_KEY: 'secret-value' },
      undefined,
      { probe }
    );
    expect(result.status).toBe('configured');
    expect(result.probe.status).toBe('verified');
    expect(result.probe.note).toContain('verified');
    expect(probe).toHaveBeenCalledWith('anthropic', { ANTHROPIC_API_KEY: 'secret-value' });
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('fails verification without probing when configuration is missing', async () => {
    const probe = vi.fn(async () => ({ available: true }));
    const result = await probeReasoningBackendAuth('anthropic', {}, undefined, { probe });
    expect(result.probe.status).toBe('failed');
    expect(result.missing_environment).toContain('ANTHROPIC_API_KEY');
    expect(probe).not.toHaveBeenCalled();
  });

  it('reports a provider rejection without exposing the credential', async () => {
    const result = await probeReasoningBackendAuth(
      'anthropic',
      { ANTHROPIC_API_KEY: 'secret-value' },
      undefined,
      { probe: async () => ({ available: false, reason: 'HTTP 401 unauthorized' }) }
    );
    expect(result.probe.status).toBe('failed');
    expect(result.probe.note).toContain('401');
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });
});

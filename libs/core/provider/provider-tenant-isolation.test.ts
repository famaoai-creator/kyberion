import { describe, expect, it } from 'vitest';
import {
  providerTenantIsolationForBackend,
  providerTenantIsolationForProvider,
  providerTenantIsolationSpecs,
} from './provider-tenant-isolation.js';

describe('provider tenant isolation registry', () => {
  it('dispatches bound-launch isolation through specs, not provider literals', () => {
    const claude = providerTenantIsolationForProvider('claude');
    expect(claude?.provider).toBe('claude');
    expect(claude?.backends).toContain('claude-cli');
    expect(providerTenantIsolationForBackend('claude-cli')).toBe(claude);
  });

  it('covers every API-key CLI provider through the generic adapter', () => {
    for (const [provider, backend] of [
      ['codex', 'codex-cli'],
      ['gemini', 'gemini-cli'],
      ['agy', 'agy-cli'],
      ['grok', 'grok-cli'],
    ] as const) {
      const spec = providerTenantIsolationForProvider(provider);
      expect(spec?.provider).toBe(provider);
      expect(spec?.backends).toContain(backend);
      expect(providerTenantIsolationForBackend(backend)).toBe(spec);
    }
  });

  it('returns undefined for backends with no isolation spec (generic env only)', () => {
    // API-proof backends take env injection only — no CLI home to isolate.
    expect(providerTenantIsolationForBackend('anthropic')).toBeUndefined();
    expect(providerTenantIsolationForBackend('openai-api')).toBeUndefined();
    // CLIs without a lendable credential path stay un-isolated.
    expect(providerTenantIsolationForBackend('opencode-cli')).toBeUndefined();
  });

  it('every spec is a complete adapter: backend, env builder, apply and redaction hooks', () => {
    expect(providerTenantIsolationSpecs().length).toBeGreaterThan(0);
    for (const spec of providerTenantIsolationSpecs()) {
      expect(spec.provider).toBeTruthy();
      expect(spec.backends.length).toBeGreaterThan(0);
      expect(typeof spec.buildEnvironment).toBe('function');
      expect(typeof spec.applyEnv).toBe('function');
      expect(typeof spec.boundSecretValues).toBe('function');
    }
  });
});

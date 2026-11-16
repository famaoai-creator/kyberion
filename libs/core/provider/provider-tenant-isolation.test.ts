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

  it('returns undefined for providers with no isolation spec (generic env only)', () => {
    expect(providerTenantIsolationForProvider('codex')).toBeUndefined();
    expect(providerTenantIsolationForProvider('grok')).toBeUndefined();
    expect(providerTenantIsolationForBackend('grok-cli')).toBeUndefined();
    expect(providerTenantIsolationForBackend('anthropic')).toBeUndefined();
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

import { describe, expect, it } from 'vitest';
import { listCliReasoningProviderDescriptors } from '../reasoning/reasoning-provider-registry.js';
import {
  providerTenantIsolationForBackend,
  providerTenantIsolationForProvider,
  providerTenantIsolationSpecs,
} from './provider-tenant-isolation.js';

describe('provider tenant isolation registry', () => {
  it('dispatches bound-launch isolation through specs, not provider literals', () => {
    const claude = providerTenantIsolationForProvider('claude');
    expect(claude?.provider).toBe('claude');
    expect(providerTenantIsolationForBackend('claude-cli')).toBe(claude);
  });

  it('covers every API-key CLI provider through the generic adapter', () => {
    for (const [provider, backend] of [
      ['codex', 'codex-cli'],
      ['gemini', 'gemini-cli'],
      ['agy', 'agy-cli'],
      ['cursor', 'cursor-cli'],
    ] as const) {
      const spec = providerTenantIsolationForProvider(provider);
      expect(spec?.provider).toBe(provider);
      expect(providerTenantIsolationForBackend(backend)).toBe(spec);
    }
  });

  it('returns undefined for backends with no isolation spec (generic env only)', () => {
    // API-proof backends take env injection only — no CLI home to isolate.
    expect(providerTenantIsolationForBackend('anthropic')).toBeUndefined();
    expect(providerTenantIsolationForBackend('openai-api')).toBeUndefined();
    // grok-cli has no lendable channel (OAuth-only CLI); opencode likewise.
    expect(providerTenantIsolationForBackend('grok-cli')).toBeUndefined();
    expect(providerTenantIsolationForBackend('opencode-cli')).toBeUndefined();
  });

  it('every spec is a complete adapter backed by a descriptor provider', () => {
    expect(providerTenantIsolationSpecs().length).toBeGreaterThan(0);
    for (const spec of providerTenantIsolationSpecs()) {
      expect(spec.provider).toBeTruthy();
      expect(typeof spec.buildEnvironment).toBe('function');
      expect(typeof spec.applyEnv).toBe('function');
      expect(typeof spec.boundSecretValues).toBe('function');
      // The provider id must round-trip: at least one CLI descriptor maps to it.
      expect(
        listCliReasoningProviderDescriptors().some(
          (descriptor) => descriptor.provider === spec.provider
        )
      ).toBe(true);
    }
  });
});

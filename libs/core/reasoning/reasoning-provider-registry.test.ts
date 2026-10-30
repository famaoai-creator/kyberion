import { describe, expect, it, afterEach, vi } from 'vitest';
import { runInExecutionScope } from '../foundation/execution-scope.js';
import { withTaskCredentialBinding } from '../foundation/credential-binding.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';
import * as secretGuardModule from '../secret/secret-guard.js';
import {
  buildRegisteredReasoningProvider,
  getReasoningProviderDescriptor,
  listReasoningProviderDescriptors,
  parseReasoningProviderDescriptor,
  registerReasoningProvider,
  resetReasoningProviderRegistryForTests,
  resolveReasoningProviderEnvironment,
} from './reasoning-provider-registry.js';

afterEach(() => {
  resetReasoningProviderRegistryForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const STUB_PROFILE = {
  streaming: false,
  tool_calling: false,
  native_subagent: false,
  thinking_levels: {},
  supports_strict_tools: false,
  supports_grammar_tools: false,
  utility_fit: [],
};

describe('reasoning provider registry', () => {
  it('loads the governed descriptor set and exposes capability metadata', () => {
    const descriptors = listReasoningProviderDescriptors();
    expect(descriptors.length).toBeGreaterThanOrEqual(20);
    expect(getReasoningProviderDescriptor('anthropic')).toMatchObject({
      provider: 'anthropic',
      module: './reasoning/reasoning-api-provider',
      capabilities: { structured_output: true, input_modalities: ['text', 'image'] },
    });
  });

  it('supports reversible provider-module registration and rejects duplicates', () => {
    const descriptor = getReasoningProviderDescriptor('stub');
    if (!descriptor) throw new Error('stub descriptor missing');
    const factory = () => null;
    const dispose = registerReasoningProvider(descriptor, factory);
    expect(() => registerReasoningProvider(descriptor, factory)).toThrow(
      'Duplicate reasoning provider factory: stub'
    );
    dispose();
    expect(() => registerReasoningProvider(descriptor, factory)).not.toThrow();
  });

  it('rejects descriptors with incomplete capability metadata instead of inventing support', () => {
    expect(
      parseReasoningProviderDescriptor({
        mode: 'stub',
        provider: 'stub',
        module: './reasoning/reasoning-backend',
        env_keys: [],
      })
    ).toBeNull();
    expect(
      parseReasoningProviderDescriptor({
        mode: 'stub',
        provider: 'stub',
        module: './reasoning/reasoning-backend',
        capabilities: {
          reasoning: true,
          structured_output: true,
          abort: false,
          session_continuity: false,
          input_modalities: ['image'],
        },
        env_keys: [],
      })
    ).toBeNull();
  });

  it('declares a cost_tier on every governed descriptor', () => {
    const descriptors = listReasoningProviderDescriptors();
    const missing = descriptors
      .filter((descriptor) => descriptor.cost_tier !== 'free' && descriptor.cost_tier !== 'metered')
      .map((descriptor) => descriptor.mode);
    expect(missing).toEqual([]);
  });

  it('rejects a descriptor with an invalid cost_tier value', () => {
    expect(
      parseReasoningProviderDescriptor({
        mode: 'stub',
        provider: 'stub',
        module: './reasoning/reasoning-backend',
        capabilities: {
          reasoning: true,
          structured_output: true,
          abort: true,
          session_continuity: false,
          input_modalities: ['text'],
        },
        env_keys: [],
        cost_tier: 'unlimited',
      })
    ).toBeNull();
  });

  it('accepts a descriptor with a valid cost_tier and without one (optional field)', () => {
    const base = {
      mode: 'stub' as const,
      provider: 'stub',
      module: './reasoning/reasoning-backend',
      capabilities: {
        reasoning: true,
        structured_output: true,
        abort: true,
        session_continuity: false,
        input_modalities: ['text'],
      },
      env_keys: [],
      transport: 'in-process',
      data_egress: 'local-only',
      adapter: 'stub',
      profile: STUB_PROFILE,
    };
    expect(parseReasoningProviderDescriptor(base)?.cost_tier).toBeUndefined();
    expect(parseReasoningProviderDescriptor({ ...base, cost_tier: 'free' })?.cost_tier).toBe(
      'free'
    );
    expect(parseReasoningProviderDescriptor({ ...base, cost_tier: 'metered' })?.cost_tier).toBe(
      'metered'
    );
  });

  it('passes an opaque bootstrap context to a registered factory', () => {
    const descriptor = getReasoningProviderDescriptor('stub');
    if (!descriptor) throw new Error('stub descriptor missing');
    let received: unknown;
    const dispose = registerReasoningProvider(descriptor, (context) => {
      received = context;
      return null;
    });
    expect(buildRegisteredReasoningProvider('stub', { force: true })).toBeNull();
    expect(received).toMatchObject({ mode: 'stub', descriptor });
    dispose();
  });

  it('preserves scope denials and unrelated failures during provider secret discovery', () => {
    const descriptor = getReasoningProviderDescriptor('anthropic')!;
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    vi.stubEnv('KYBERION_TENANT', 'INVALID/TENANT');
    expect(() => resolveReasoningProviderEnvironment(descriptor)).toThrow(
      '[CREDENTIAL_SCOPE_DENIED]'
    );
    runInExecutionScope({ tenantBound: true, tenantSlug: 'alpha' }, () =>
      runInResourceAccessScope(
        { tenantSlug: 'beta', readExact: [], writeExact: [], mkdirExact: [] },
        () =>
          expect(() => resolveReasoningProviderEnvironment(descriptor)).toThrow(
            '[CREDENTIAL_SCOPE_DENIED]'
          )
      )
    );
    const failure = new Error('secret resolver unavailable');
    vi.spyOn(secretGuardModule, 'getSecretForIdentity').mockImplementation(() => {
      throw failure;
    });
    expect(() => resolveReasoningProviderEnvironment(descriptor)).toThrow(failure);
  });

  it('resolves a matching task binding without using ambient operator credentials', () => {
    const descriptor = getReasoningProviderDescriptor('anthropic')!;
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    runInExecutionScope({ tenantBound: true, tenantSlug: 'alpha' }, () =>
      withTaskCredentialBinding(
        { tenantSlug: 'alpha', secrets: { ANTHROPIC_API_KEY: 'bound-test-key' } },
        () => {
          expect(resolveReasoningProviderEnvironment(descriptor).ANTHROPIC_API_KEY).toBe(
            'bound-test-key'
          );
          expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
        }
      )
    );
  });

  it('treats a missing credential binding as an unavailable provider secret', () => {
    const descriptor = getReasoningProviderDescriptor('anthropic');
    if (!descriptor?.secret_refs?.length)
      throw new Error('anthropic descriptor must declare secret_refs');
    const previousTenant = process.env.KYBERION_TENANT;
    const previousKey = process.env.ANTHROPIC_API_KEY;
    try {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.KYBERION_TENANT = 'vitest-tenant';
      const resolved = resolveReasoningProviderEnvironment(descriptor);
      expect(resolved.ANTHROPIC_API_KEY).toBeUndefined();
      expect(resolved).toBe(process.env);
    } finally {
      if (previousTenant === undefined) delete process.env.KYBERION_TENANT;
      else process.env.KYBERION_TENANT = previousTenant;
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
    }
  });
});

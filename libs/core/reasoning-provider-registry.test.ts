import { describe, expect, it, afterEach } from 'vitest';
import {
  buildRegisteredReasoningProvider,
  getReasoningProviderDescriptor,
  listReasoningProviderDescriptors,
  parseReasoningProviderDescriptor,
  registerReasoningProvider,
  resetReasoningProviderRegistryForTests,
} from './reasoning-provider-registry.js';

afterEach(() => resetReasoningProviderRegistryForTests());

describe('reasoning provider registry', () => {
  it('loads the governed descriptor set and exposes capability metadata', () => {
    const descriptors = listReasoningProviderDescriptors();
    expect(descriptors.length).toBeGreaterThanOrEqual(20);
    expect(getReasoningProviderDescriptor('anthropic')).toMatchObject({
      provider: 'anthropic',
      module: './reasoning-api-provider',
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
        module: './reasoning-backend',
        env_keys: [],
      })
    ).toBeNull();
    expect(
      parseReasoningProviderDescriptor({
        mode: 'stub',
        provider: 'stub',
        module: './reasoning-backend',
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
});

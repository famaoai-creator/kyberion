import { describe, expect, it } from 'vitest';
import { getSurfaceProviderDefinition, getSurfaceProviderManifest } from '@agent/core';

/**
 * UX brush-up: the terminal is a first-class surface. `pnpm kyberion ask`
 * routes through the same brain as the bridges, which requires the `cli`
 * provider to exist in both the runtime registry and the governed manifest.
 */
describe('cli surface provider', () => {
  it('is registered in the runtime surface registry', () => {
    const definition = getSurfaceProviderDefinition('cli');
    expect(definition.id).toBe('cli');
    expect(definition.capabilities.reply).toBe(true);
    expect(definition.capabilities.asyncRequest).toBe(true);
  });

  it('has a governed manifest record with routing policy', () => {
    const manifest = getSurfaceProviderManifest('cli');
    expect(manifest.agentId).toBe('cli-surface-agent');
    expect(manifest.interactionMode).toBe('session');
    expect(manifest.delivery.supportsOutbox).toBe(false);
  });
});

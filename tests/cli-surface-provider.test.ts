import { describe, expect, it } from 'vitest';
import {
  getAgentManifest,
  getSurfaceProviderDefinition,
  getSurfaceProviderManifest,
} from '@agent/core';

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

  it('has a matching executable agent manifest', () => {
    const manifest = getAgentManifest('cli-surface-agent');
    expect(manifest?.agentId).toBe('cli-surface-agent');
    expect(manifest?.capabilities).toContain('conversation');
    expect(manifest?.selection_hints).toMatchObject({
      preferred_provider: 'codex',
      preferred_modelId: 'codex',
      provider_strategy: 'adaptive',
    });
    expect(manifest?.selection_hints?.fallback_providers).not.toContain('gemini');
  });
});

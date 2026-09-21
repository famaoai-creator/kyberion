/**
 * A provider's hosts are declared once, next to the provider. The reasoning
 * layer keeps its own backend → endpoint table; if the two drift, approving a
 * provider for a tenant silently stops covering the host it really calls.
 */
import { describe, expect, it } from 'vitest';
import { providerEndpointDomains } from './provider-endpoint-domains.js';
import { reasoningBackendEndpoint } from './reasoning-egress-scope.js';

const BACKEND_PROVIDER: Record<string, string> = {
  'claude-cli': 'claude',
  'codex-cli': 'codex',
  'agy-cli': 'agy',
  'gemini-cli': 'gemini',
  'cursor-cli': 'cursor',
  'copilot-acp': 'copilot',
  'grok-cli': 'grok',
  'opencode-cli': 'opencode',
};

describe('provider endpoint domains', () => {
  it.each(Object.entries(BACKEND_PROVIDER))(
    '%s calls a host its provider (%s) declares',
    (backend, provider) => {
      const host = new URL(reasoningBackendEndpoint(backend)).hostname;
      const domains = providerEndpointDomains(provider);
      expect(domains.some((d) => host === d || host.endsWith(`.${d}`))).toBe(true);
    }
  );

  it('declares no hosts for a local-only provider', () => {
    expect(providerEndpointDomains('laya-mlx')).toEqual([]);
  });

  it('resolves an unknown provider to nothing rather than throwing', () => {
    expect(providerEndpointDomains('no-such-provider')).toEqual([]);
  });
});

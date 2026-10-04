import { afterEach, describe, expect, it } from 'vitest';
import {
  backendHasLiveToolCandidate,
  buildFailoverReasoningBackend,
  buildRoleAwareReasoningBackend,
  FailoverReasoningBackend,
  stubReasoningBackend,
  type ReasoningBackend,
} from './reasoning-backend.js';
import {
  clearProviderHealth,
  reportProviderTemporarilyUnhealthy,
} from '../provider/provider-health-registry.js';

function toolBackend(name: string): ReasoningBackend {
  return {
    ...stubReasoningBackend,
    name,
    generateWithTools: async () => ({ text: 'ok', toolCalls: [] }) as never,
  };
}

function textBackend(name: string): ReasoningBackend {
  return { ...stubReasoningBackend, name };
}

afterEach(() => {
  clearProviderHealth();
});

describe('liveCapabilities', () => {
  it('reports tool capability from non-demoted candidates only', () => {
    const backend = new FailoverReasoningBackend([
      { backend: toolBackend('anthropic'), provider: 'anthropic' },
      { backend: textBackend('claude-cli'), provider: 'claude-cli' },
    ]);
    // Constructed with a tool candidate, so the static capability is set…
    expect(backend.generateWithTools).toBeTypeOf('function');
    expect(backend.liveCapabilities()).toEqual({
      tools: true,
      candidates: ['anthropic', 'claude-cli'],
    });
    expect(backendHasLiveToolCandidate(backend)).toBe(true);

    // …but once the only tool candidate is demoted, the live answer flips.
    reportProviderTemporarilyUnhealthy('anthropic', { retryAfterMs: 60_000 });
    expect(backend.generateWithTools).toBeTypeOf('function');
    expect(backend.liveCapabilities()).toEqual({ tools: false, candidates: ['claude-cli'] });
    expect(backendHasLiveToolCandidate(backend)).toBe(false);
  });

  it('passes through the chain a role routes to', () => {
    const defaultChain = buildFailoverReasoningBackend([
      { backend: textBackend('codex-cli'), provider: 'codex-cli' },
    ]);
    const roleChain = buildFailoverReasoningBackend([
      { backend: toolBackend('anthropic'), provider: 'anthropic' },
    ]);
    const roleAware = buildRoleAwareReasoningBackend(
      defaultChain,
      new Map([['infrastructure_sentinel', roleChain]])
    );
    expect(backendHasLiveToolCandidate(roleAware)).toBe(false);
    expect(backendHasLiveToolCandidate(roleAware, 'infrastructure_sentinel')).toBe(true);
  });

  it('falls back to generateWithTools presence for plain backends', () => {
    expect(backendHasLiveToolCandidate(toolBackend('x'))).toBe(true);
    expect(backendHasLiveToolCandidate(stubReasoningBackend)).toBe(false);
  });
});

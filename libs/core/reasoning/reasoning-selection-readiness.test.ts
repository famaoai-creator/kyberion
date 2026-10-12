import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReasoningRoutePolicy } from './reasoning-route-resolver.js';

const probes = vi.hoisted(() => ({
  discover: vi.fn(() => {
    throw new Error('live discovery is forbidden');
  }),
  peek: vi.fn(),
  capability: vi.fn(),
}));
vi.mock('../provider/provider-discovery.js', () => ({
  discoverProviders: probes.discover,
  peekProviderDiscovery: probes.peek,
}));
vi.mock('../provider/provider-capability-registry.js', () => ({
  peekProviderCapabilityRegistry: probes.capability,
}));
import { peekReasoningSelectionReadiness } from './reasoning-selection-readiness.js';

const policy: ReasoningRoutePolicy = {
  version: 'fixture',
  runtime_adapters: {
    'codex-cli': {
      adapter: 'codex-cli',
      capabilities: ['text'],
      supported_parameters: [],
      selection: {
        display_name: 'Codex',
        discovery_provider: 'codex',
        availability: { kind: 'provider_discovery' },
      },
    },
    anthropic: {
      adapter: 'anthropic-sdk',
      capabilities: ['text'],
      supported_parameters: [],
      selection: {
        display_name: 'Anthropic',
        availability: { kind: 'env_any', names: ['ANTHROPIC_API_KEY'] },
      },
    },
    stub: {
      adapter: 'stub',
      capabilities: ['text'],
      supported_parameters: [],
      selection: { display_name: 'Stub', availability: { kind: 'always' } },
    },
  },
  profiles: {},
  roles: {},
  fallback: { max_attempts: 1, max_in_place_retries: 0, on_unsupported_parameter: 'reject' },
};

describe('reasoning selection cached readiness', () => {
  beforeEach(() => {
    probes.peek.mockReturnValue({ providers: [], source: 'unavailable' });
    probes.capability.mockReturnValue(null);
    probes.discover.mockClear();
  });
  it('does not probe when cached discovery is missing', () => {
    const result = peekReasoningSelectionReadiness(policy, {});
    expect(result['codex-cli']?.available).toBe(false);
    expect(result.stub?.available).toBe(true);
    expect(probes.discover).not.toHaveBeenCalled();
  });
  it('uses healthy cached discovery but honors cached negative capability evidence', () => {
    probes.peek.mockReturnValue({
      source: 'disk',
      providers: [{ provider: 'codex', installed: true, healthy: true }],
    });
    expect(peekReasoningSelectionReadiness(policy, {})['codex-cli']?.available).toBe(true);
    probes.capability.mockReturnValue([
      { provider_id: 'codex', binary_found: true, authenticated: false },
    ]);
    expect(peekReasoningSelectionReadiness(policy, {})['codex-cli']?.available).toBe(false);
    expect(probes.discover).not.toHaveBeenCalled();
  });
  it('only tests configuration presence and never returns credential values', () => {
    const result = peekReasoningSelectionReadiness(policy, {
      ANTHROPIC_API_KEY: 'fixture-secret-never-return',
    });
    expect(result.anthropic?.available).toBe(true);
    expect(result.anthropic?.reason).toContain('not been probed');
    expect(JSON.stringify(result)).not.toContain('fixture-secret-never-return');
    expect(probes.discover).not.toHaveBeenCalled();
  });
});

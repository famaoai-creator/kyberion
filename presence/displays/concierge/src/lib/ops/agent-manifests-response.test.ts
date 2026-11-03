import { describe, expect, it } from 'vitest';
import { parseAgentManifestsResponse } from './agent-manifests-response';

const manifest = {
  agentId: 'reviewer',
  provider: 'claude',
  modelId: 'sonnet',
  capabilities: ['review'],
  trustRequired: 0.7,
  requiresEnv: ['ANTHROPIC_API_KEY'],
  providerStrategy: 'preferred',
  fallbackProviders: ['codex'],
};

describe('agent manifests response boundary', () => {
  it('accepts the manifest fields consumed by AgentPanel', () => {
    expect(
      parseAgentManifestsResponse({
        status: 'ok',
        accessRole: 'localadmin',
        manifests: [manifest],
      })
    ).toEqual({ status: 'ok', accessRole: 'localadmin', manifests: [manifest] });
  });

  it('rejects missing required manifest identity and unsafe nested keys', () => {
    expect(
      parseAgentManifestsResponse({
        status: 'ok',
        accessRole: 'readonly',
        manifests: [{ ...manifest, modelId: '' }],
      })
    ).toBeUndefined();
    const unsafe = JSON.parse('{"__proto__":"bad"}');
    expect(
      parseAgentManifestsResponse({
        status: 'ok',
        accessRole: 'readonly',
        manifests: [{ ...manifest, fallbackProviders: unsafe }],
      })
    ).toBeUndefined();
  });

  it('rejects invalid access role and trust threshold', () => {
    expect(
      parseAgentManifestsResponse({
        status: 'ok',
        accessRole: 'admin',
        manifests: [],
      })
    ).toBeUndefined();
    expect(
      parseAgentManifestsResponse({
        status: 'ok',
        accessRole: 'readonly',
        manifests: [{ ...manifest, trustRequired: -1 }],
      })
    ).toBeUndefined();
  });
});

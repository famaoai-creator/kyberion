import { describe, expect, it } from 'vitest';
import { parseAgentHealthResponse } from './agent-health-response';

const agent = {
  agentId: 'agent-1',
  provider: 'claude',
  modelId: 'sonnet',
  status: 'ready',
  capabilities: ['chat'],
  trustScore: 0.9,
  uptimeMs: 1000,
  idleMs: 20,
  runtime: {
    kind: 'agent',
    state: 'running',
    pid: 123,
    idleForMs: 20,
    shutdownPolicy: 'manual',
  },
  metrics: {
    turnCount: 2,
    errorCount: 0,
    restartCount: 0,
    refreshCount: 1,
    totalPromptChars: 10,
    totalResponseChars: 20,
    usage: { totalTokens: 30 },
  },
  process: { rssKb: 12, cpuPercent: 1.5 },
  supportsSoftRefresh: true,
  providerRuntime: { provider_resolution: { strategy: 'preferred' } },
  providerResolution: {
    preferredProvider: 'claude',
    preferredModelId: 'sonnet',
    strategy: 'preferred',
    availableProviders: ['claude'],
  },
};

describe('agent health response boundary', () => {
  it('accepts the health fields consumed by AgentPanel', () => {
    expect(
      parseAgentHealthResponse({
        status: 'ok',
        accessRole: 'readonly',
        total: 1,
        ready: 1,
        busy: 0,
        error: 0,
        agents: [agent],
      })
    ).toEqual({
      status: 'ok',
      accessRole: 'readonly',
      total: 1,
      ready: 1,
      busy: 0,
      error: 0,
      agents: [agent],
    });
  });

  it('rejects malformed nested metrics and unsafe provider runtime data', () => {
    expect(
      parseAgentHealthResponse({
        status: 'ok',
        accessRole: 'readonly',
        total: 1,
        ready: 1,
        busy: 0,
        error: 0,
        agents: [{ ...agent, metrics: { ...agent.metrics, errorCount: -1 } }],
      })
    ).toBeUndefined();
    const unsafeRuntime = JSON.parse('{"__proto__":"bad"}');
    expect(
      parseAgentHealthResponse({
        status: 'ok',
        accessRole: 'readonly',
        total: 1,
        ready: 1,
        busy: 0,
        error: 0,
        agents: [{ ...agent, providerRuntime: unsafeRuntime }],
      })
    ).toBeUndefined();
  });

  it('rejects invalid access role and count types', () => {
    expect(
      parseAgentHealthResponse({
        status: 'ok',
        accessRole: 'admin',
        total: 1,
        ready: 1,
        busy: 0,
        error: 0,
        agents: [],
      })
    ).toBeUndefined();
    expect(
      parseAgentHealthResponse({
        status: 'ok',
        accessRole: 'readonly',
        total: '1',
        ready: 1,
        busy: 0,
        error: 0,
        agents: [],
      })
    ).toBeUndefined();
    expect(
      parseAgentHealthResponse({
        status: 'ok',
        accessRole: 'readonly',
        total: 1,
        ready: 1,
        busy: 0,
        error: 0,
        agents: [{ ...agent, trustScore: undefined }],
      })
    ).toBeUndefined();
  });
});

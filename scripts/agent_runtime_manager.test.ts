import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(async () => ({
    agentId: 'demo-agent-1234',
    getRecord: () => ({ agentId: 'demo-agent-1234', status: 'ready' }),
  })),
  shutdown: vi.fn(async () => {}),
  list: vi.fn(() => [
    {
      agentId: 'demo-agent-1234',
      status: 'ready',
      provider: 'gemini',
      modelId: 'gemini-2.0-flash-exp',
      missionId: 'MSN-1',
    },
  ]),
  get: vi.fn(() => ({ agentId: 'demo-agent-1234' })),
  getSnapshot: vi.fn(() => null),
  loadAgentManifests: vi.fn(() => [
    { agentId: 'manifest-a', autoSpawn: true, trustRequired: false, systemPrompt: 'Manifest A\nmore text' },
  ]),
  getAgentManifest: vi.fn(() => ({
    systemPrompt: 'Manifest A\nmore text',
    capabilities: ['x'],
    selection_hints: { preferred_provider: 'claude', preferred_modelId: 'claude-3.5-sonnet' },
  })),
  record: vi.fn(),
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@agent/core', () => ({
  createStandardYargs: vi.fn(),
  agentLifecycle: { spawn: mocks.spawn, shutdown: mocks.shutdown, getSnapshot: mocks.getSnapshot },
  agentRegistry: { list: mocks.list, get: mocks.get },
  loadAgentManifests: mocks.loadAgentManifests,
  getAgentManifest: mocks.getAgentManifest,
  logger: mocks.logger,
  pathResolver: { rootDir: vi.fn(() => '/tmp/kyberion') },
  auditChain: { record: mocks.record },
}));

import { inspectAgent, listManifests, listRunningAgents, spawnAgent } from './agent_runtime_manager.js';

describe('agent_runtime_manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prints a running agent table', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await listRunningAgents();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('AGENT_ID'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('demo-agent-1234'));
    spy.mockRestore();
  });

  it('prints manifest listing rows', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await listManifests();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('MANIFEST_ID'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('manifest-a'));
    spy.mockRestore();
  });

  it('spawns an agent from the manifest defaults', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await spawnAgent('manifest-a', { missionId: 'MSN-TEST' });
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude',
        modelId: 'claude-3.5-sonnet',
        missionId: 'MSN-TEST',
      }),
    );
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent.manual_spawn' }));
    spy.mockRestore();
  });

  it('inspects a registered but inactive agent', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await inspectAgent('demo-agent-1234');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('registered but not actively managed'));
    spy.mockRestore();
  });
});

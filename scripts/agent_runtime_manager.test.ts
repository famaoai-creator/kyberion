import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

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
    {
      agentId: 'manifest-a',
      autoSpawn: true,
      trustRequired: false,
      systemPrompt: 'Manifest A\nmore text',
    },
  ]),
  getAgentManifest: vi.fn(() => ({
    systemPrompt: 'Manifest A\nmore text',
    capabilities: ['x'],
    selection_hints: { preferred_provider: 'claude', preferred_modelId: 'claude-3.5-sonnet' },
  })),
  record: vi.fn(),
  classifyError: vi.fn(() => ({
    category: 'policy_violation',
    remediation: 'Check runtime permissions.',
  })),
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@agent/core/cli-utils', () => ({
  createStandardYargs: vi.fn(),
}));

vi.mock('@agent/core/agent-lifecycle', () => ({
  agentLifecycle: { spawn: mocks.spawn, shutdown: mocks.shutdown, getSnapshot: mocks.getSnapshot },
}));

vi.mock('@agent/core/agent-registry', () => ({
  agentRegistry: { list: mocks.list, get: mocks.get },
}));

vi.mock('@agent/core/agent-manifest', () => ({
  loadAgentManifests: mocks.loadAgentManifests,
  getAgentManifest: mocks.getAgentManifest,
}));

vi.mock('@agent/core/core', () => ({
  logger: mocks.logger,
}));

vi.mock('@agent/core/audit-chain', () => ({
  auditChain: { record: mocks.record },
}));

vi.mock('@agent/core/error-classifier', () => ({
  classifyError: mocks.classifyError,
}));

import {
  inspectAgent,
  listManifests,
  listRunningAgents,
  spawnAgent,
} from './agent_runtime_manager.js';

describe('agent_runtime_manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prints a running agent table', async () => {
    const print = vi.fn();
    await listRunningAgents(print);
    expect(print).toHaveBeenCalledWith(expect.stringContaining('AGENT_ID'));
    expect(print).toHaveBeenCalledWith(expect.stringContaining('demo-agent-1234'));
  });

  it('prints manifest listing rows', async () => {
    const print = vi.fn();
    await listManifests(print);
    expect(print).toHaveBeenCalledWith(expect.stringContaining('MANIFEST_ID'));
    expect(print).toHaveBeenCalledWith(expect.stringContaining('manifest-a'));
  });

  it('spawns an agent from the manifest defaults', async () => {
    const print = vi.fn();
    await spawnAgent('manifest-a', { missionId: 'MSN-TEST' }, print);
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude',
        modelId: 'claude-3.5-sonnet',
        missionId: 'MSN-TEST',
      })
    );
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent.manual_spawn' })
    );
    expect(print).toHaveBeenCalledWith(expect.stringContaining('demo-agent-1234'));
  });

  it('audits classified spawn failures before rethrowing', async () => {
    mocks.spawn.mockRejectedValueOnce(new Error('permission denied by runtime policy'));

    await expect(spawnAgent('manifest-a', { missionId: 'MSN-TEST' }, vi.fn())).rejects.toThrow(
      'permission denied'
    );

    expect(mocks.classifyError).toHaveBeenCalledWith(expect.any(Error));
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent.manual_spawn',
        operation: 'manifest-a',
        result: 'failed',
        metadata: expect.objectContaining({
          classification: expect.objectContaining({ category: 'policy_violation' }),
        }),
      })
    );
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('policy_violation'));
  });

  it('inspects a registered but inactive agent', async () => {
    const print = vi.fn();
    await inspectAgent('demo-agent-1234', print);
    expect(print).toHaveBeenCalledWith(
      expect.stringContaining('registered but not actively managed')
    );
  });

  it('delegates command failures to the shared script harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/agent_runtime_manager.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.error(');
    expect(source).not.toContain('process.exitCode = 1');
  });
});

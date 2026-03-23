import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const get = vi.fn();
  const stopAgentRuntime = vi.fn();
  const shutdownAgentRuntimeViaDaemon = vi.fn();
  const getScore = vi.fn();
  const detectRegimeShift = vi.fn();
  const recordEvent = vi.fn();
  const record = vi.fn();
  const recordLifecycle = vi.fn();

  return {
    get,
    stopAgentRuntime,
    shutdownAgentRuntimeViaDaemon,
    getScore,
    detectRegimeShift,
    recordEvent,
    record,
    recordLifecycle,
  };
});

vi.mock('./agent-registry.js', () => ({
  agentRegistry: {
    get: mocks.get,
  },
}));

vi.mock('./agent-runtime-supervisor.js', () => ({
  stopAgentRuntime: mocks.stopAgentRuntime,
}));

vi.mock('./agent-runtime-supervisor-client.js', () => ({
  shutdownAgentRuntimeViaDaemon: mocks.shutdownAgentRuntimeViaDaemon,
}));

vi.mock('./trust-engine.js', () => ({
  trustEngine: {
    getScore: mocks.getScore,
    detectRegimeShift: mocks.detectRegimeShift,
    recordEvent: mocks.recordEvent,
  },
}));

vi.mock('./audit-chain.js', () => ({
  auditChain: {
    record: mocks.record,
    recordLifecycle: mocks.recordLifecycle,
  },
}));

vi.mock('./core.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe('kill-switch', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.get.mockReturnValue({ agentId: 'agent-x' });
    mocks.getScore.mockReturnValue(null);
    mocks.detectRegimeShift.mockReturnValue({ shifted: false, divergence: 0 });
  });

  it('prefers supervisor daemon shutdown for severe anomalies', async () => {
    mocks.shutdownAgentRuntimeViaDaemon.mockResolvedValue({ stopped: true });
    const { killSwitch } = await import('./kill-switch.js');
    const result = await killSwitch.respond('agent-x', ['a', 'b', 'c']);

    expect(mocks.shutdownAgentRuntimeViaDaemon).toHaveBeenCalledWith('agent-x', 'kill_switch');
    expect(mocks.stopAgentRuntime).not.toHaveBeenCalled();
    expect(result).toBe('killed');
  });

  it('falls back to local stop when daemon shutdown fails', async () => {
    mocks.shutdownAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
    mocks.stopAgentRuntime.mockResolvedValue(undefined);
    const { killSwitch } = await import('./kill-switch.js');
    const result = await killSwitch.respond('agent-x', ['a', 'b', 'c']);

    expect(mocks.shutdownAgentRuntimeViaDaemon).toHaveBeenCalledWith('agent-x', 'kill_switch');
    expect(mocks.stopAgentRuntime).toHaveBeenCalledWith('agent-x', 'kill_switch');
    expect(result).toBe('killed');
  });
});

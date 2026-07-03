import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { resolveAgentProviderTargetMock } = vi.hoisted(() => ({
  resolveAgentProviderTargetMock: vi.fn(
    ({
      preferredProvider,
      preferredModelId,
    }: {
      preferredProvider: string;
      preferredModelId?: string;
    }) => ({
      provider: preferredProvider,
      modelId: preferredModelId || preferredProvider,
      strategy: 'preferred' as const,
      availableProviders: [preferredProvider],
    })
  ),
}));

vi.mock('@agent/core/agent-provider-resolution', async () => ({
  resolveAgentProviderTarget: resolveAgentProviderTargetMock,
}));

import { agentLifecycle } from '@agent/core/agent-lifecycle';
import { runtimeSupervisor } from '@agent/core/runtime-supervisor';
import { agentRegistry } from '@agent/core/agent-registry';
import { ACPMediator } from '@agent/core/acp-mediator';
import { CodexAppServerAdapter } from '@agent/core/agent-adapter';

describe('agent runtime observability', () => {
  beforeEach(async () => {
    await agentLifecycle.shutdownAll();
    runtimeSupervisor.resetForTests();
    resolveAgentProviderTargetMock.mockClear();
  });

  afterEach(async () => {
    await agentLifecycle.shutdownAll();
    runtimeSupervisor.resetForTests();
    vi.restoreAllMocks();
  });

  it('builds runtime snapshots with metrics and provider runtime info', async () => {
    vi.spyOn(ACPMediator.prototype, 'boot').mockResolvedValue();
    vi.spyOn(ACPMediator.prototype, 'ask').mockResolvedValue('hello world');
    vi.spyOn(ACPMediator.prototype, 'shutdown').mockResolvedValue();
    vi.spyOn(ACPMediator.prototype, 'getRuntimeInfo').mockReturnValue({
      pid: 12345,
      sessionId: 'session-1',
      usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
      supportsSoftRefresh: true,
      alive: true,
      crashed: false,
    });

    const handle = await agentLifecycle.spawn({
      agentId: 'obs-agent',
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
    });

    await handle.ask('ping');
    const snapshot = agentLifecycle.getSnapshot('obs-agent');

    expect(snapshot?.agent.agentId).toBe('obs-agent');
    expect(snapshot?.metrics.turnCount).toBe(1);
    expect(snapshot?.metrics.totalPromptChars).toBe(4);
    expect(snapshot?.metrics.totalResponseChars).toBe(11);
    expect(snapshot?.metrics.usage?.totalTokens).toBe(19);
    expect(snapshot?.providerRuntime?.sessionId).toBe('session-1');
    expect(snapshot?.supportsSoftRefresh).toBe(true);
  });

  it('performs soft refresh when the provider supports it', async () => {
    vi.spyOn(ACPMediator.prototype, 'boot').mockResolvedValue();
    vi.spyOn(ACPMediator.prototype, 'ask').mockResolvedValue('ok');
    vi.spyOn(ACPMediator.prototype, 'shutdown').mockResolvedValue();
    const refreshSpy = vi.spyOn(ACPMediator.prototype, 'refreshContext').mockResolvedValue({
      mode: 'soft',
      sessionId: 'session-2',
    });
    vi.spyOn(ACPMediator.prototype, 'getRuntimeInfo').mockReturnValue({
      pid: 12345,
      sessionId: 'session-2',
      usage: {},
      supportsSoftRefresh: true,
      alive: true,
      crashed: false,
    });

    await agentLifecycle.spawn({
      agentId: 'refresh-agent',
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
    });

    const result = await agentLifecycle.refreshContext('refresh-agent');

    expect(refreshSpy).toHaveBeenCalledOnce();
    expect(result.mode).toBe('soft');
    expect(result.snapshot?.metrics.refreshCount).toBe(1);
  });

  it('restarts an agent when requested explicitly', async () => {
    vi.spyOn(ACPMediator.prototype, 'boot').mockResolvedValue();
    vi.spyOn(ACPMediator.prototype, 'ask').mockResolvedValue('ok');
    vi.spyOn(ACPMediator.prototype, 'shutdown').mockResolvedValue();
    vi.spyOn(ACPMediator.prototype, 'getRuntimeInfo').mockReturnValue({
      pid: 12345,
      sessionId: 'session-3',
      usage: {},
      supportsSoftRefresh: true,
      alive: true,
      crashed: false,
    });

    await agentLifecycle.spawn({
      agentId: 'restart-agent',
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
    });

    await agentLifecycle.restart('restart-agent');
    const snapshot = agentLifecycle.getSnapshot('restart-agent');

    expect(agentRegistry.get('restart-agent')?.status).toBe('ready');
    expect(snapshot?.metrics.restartCount).toBe(1);
  });

  it('preserves refresh metrics across restart', async () => {
    vi.spyOn(ACPMediator.prototype, 'boot').mockResolvedValue();
    vi.spyOn(ACPMediator.prototype, 'ask').mockResolvedValue('ok');
    vi.spyOn(ACPMediator.prototype, 'shutdown').mockResolvedValue();
    vi.spyOn(ACPMediator.prototype, 'refreshContext').mockResolvedValue({
      mode: 'soft',
      sessionId: 'session-4',
    });
    vi.spyOn(ACPMediator.prototype, 'getRuntimeInfo').mockReturnValue({
      pid: 12345,
      sessionId: 'session-4',
      usage: {},
      supportsSoftRefresh: true,
      alive: true,
      crashed: false,
    });

    await agentLifecycle.spawn({
      agentId: 'preserve-agent',
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
    });

    const refreshed = await agentLifecycle.refreshContext('preserve-agent');
    expect(refreshed.snapshot?.metrics.refreshCount).toBe(1);

    await agentLifecycle.restart('preserve-agent');
    const snapshot = agentLifecycle.getSnapshot('preserve-agent');

    expect(snapshot?.metrics.refreshCount).toBe(1);
    expect(snapshot?.metrics.lastRefreshedAt).toBeDefined();
    expect(snapshot?.metrics.restartCount).toBe(1);
  });

  it('marks ACP agents unhealthy when the provider process is gone', async () => {
    vi.spyOn(ACPMediator.prototype, 'boot').mockResolvedValue();
    vi.spyOn(ACPMediator.prototype, 'ask').mockResolvedValue('ok');
    vi.spyOn(ACPMediator.prototype, 'shutdown').mockResolvedValue();
    vi.spyOn(ACPMediator.prototype, 'isProcessAlive').mockReturnValue(false);
    vi.spyOn(ACPMediator.prototype, 'getRuntimeInfo').mockReturnValue({
      pid: 999999,
      sessionId: 'session-dead',
      usage: {},
      supportsSoftRefresh: true,
      alive: false,
      crashed: true,
    });

    await agentLifecycle.spawn({
      agentId: 'dead-agent',
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
    });

    const health = await agentLifecycle.healthCheck();

    expect(health.get('dead-agent')).toBe('error');
    expect(agentRegistry.get('dead-agent')?.status).toBe('error');
  });

  it('marks exec app-server agents unhealthy when the provider process is gone', async () => {
    vi.spyOn(CodexAppServerAdapter.prototype, 'boot').mockResolvedValue();
    vi.spyOn(CodexAppServerAdapter.prototype, 'ask').mockResolvedValue({
      text: 'ok',
      stopReason: 'completed',
    } as any);
    vi.spyOn(CodexAppServerAdapter.prototype, 'shutdown').mockResolvedValue();
    vi.spyOn(CodexAppServerAdapter.prototype, 'getRuntimeInfo').mockReturnValue({
      pid: 424242,
      threadId: 'thread-dead',
      usage: {},
      supportsSoftRefresh: true,
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });

    await agentLifecycle.spawn({
      agentId: 'codex-dead-agent',
      provider: 'codex',
      modelId: 'gpt-5.5',
    });

    const health = await agentLifecycle.healthCheck();

    expect(killSpy).toHaveBeenCalledWith(424242, 0);
    expect(health.get('codex-dead-agent')).toBe('error');
    expect(agentRegistry.get('codex-dead-agent')?.status).toBe('error');
  });

  it('auto-restarts crashed ACP agents within the restart budget', async () => {
    vi.spyOn(ACPMediator.prototype, 'boot').mockResolvedValue();
    vi.spyOn(ACPMediator.prototype, 'ask').mockResolvedValue('ok');
    vi.spyOn(ACPMediator.prototype, 'shutdown').mockResolvedValue();
    vi.spyOn(ACPMediator.prototype, 'getRuntimeInfo').mockReturnValue({
      pid: 12345,
      sessionId: 'session-restart',
      usage: {},
      supportsSoftRefresh: true,
      alive: true,
      crashed: false,
    });
    vi.spyOn(ACPMediator.prototype, 'isProcessAlive').mockReturnValue(false);
    const restartSpy = vi.spyOn(agentLifecycle, 'restart').mockResolvedValue({
      agentId: 'restart-agent',
      ask: async () => 'ok',
      shutdown: async () => {},
      getRecord: () => agentRegistry.get('restart-agent'),
    } as any);

    await agentLifecycle.spawn({
      agentId: 'restart-agent',
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
      restartPolicy: {
        maxRestarts: 1,
        windowMs: 10 * 60 * 1000,
      },
    });

    const firstHealth = await agentLifecycle.healthCheck();
    expect(firstHealth.get('restart-agent')).toBe('ready');
    expect(restartSpy).toHaveBeenCalledTimes(1);

    const secondHealth = await agentLifecycle.healthCheck();
    expect(secondHealth.get('restart-agent')).toBe('error');
    expect(restartSpy).toHaveBeenCalledTimes(1);
  });
});

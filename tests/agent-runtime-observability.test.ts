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
    }),
  ),
}));

vi.mock('@agent/core/agent-provider-resolution', async () => ({
  resolveAgentProviderTarget: resolveAgentProviderTargetMock,
}));

import { agentLifecycle } from '@agent/core/agent-lifecycle';
import { runtimeSupervisor } from '@agent/core/runtime-supervisor';
import { agentRegistry } from '@agent/core/agent-registry';
import { ACPMediator } from '@agent/core/acp-mediator';

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
      usage: null,
      supportsSoftRefresh: true,
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
      usage: null,
      supportsSoftRefresh: true,
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
      usage: null,
      supportsSoftRefresh: true,
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
});

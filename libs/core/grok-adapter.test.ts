import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrokAdapter } from './agent-adapter.js';

const grokParent = Object.getPrototypeOf(GrokAdapter.prototype) as {
  ask: (prompt: string, options?: unknown) => Promise<{ text: string; stopReason: string }>;
};

function primedAdapter(): GrokAdapter {
  const adapter = new GrokAdapter({ bin: 'grok', model: 'grok-4.6' });
  (adapter as unknown as { connection: object }).connection = {};
  (adapter as unknown as { acpSessionId: string }).acpSessionId = 'sess-grok-1';
  return adapter;
}

describe('GrokAdapter native spawn_subagent observation', () => {
  const previous = process.env.GROK_SUBAGENTS;

  afterEach(() => {
    if (previous === undefined) delete process.env.GROK_SUBAGENTS;
    else process.env.GROK_SUBAGENTS = previous;
    vi.restoreAllMocks();
  });

  it('fails closed when the parent turn never invoked spawn_subagent', async () => {
    const adapter = primedAdapter();
    vi.spyOn(grokParent, 'ask').mockResolvedValue({
      text: 'I solved it in the parent session',
      stopReason: 'completed',
    });

    await expect(adapter.askNativeSubagent('delegate this')).rejects.toThrow(
      '[SUBAGENT_UNAVAILABLE] Grok did not provide both native spawn_subagent invocation and completion evidence.'
    );
  });

  it('accepts an observed spawn_subagent tool event as native proof', async () => {
    const adapter = primedAdapter();
    vi.spyOn(grokParent, 'ask').mockImplementation(async () => {
      (
        adapter as unknown as { handleSessionUpdate: (params: unknown) => void }
      ).handleSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCall: { name: 'spawn_subagent', subagentId: 'child-grok-1' },
      });
      (
        adapter as unknown as { handleSessionUpdate: (params: unknown) => void }
      ).handleSessionUpdate({
        sessionUpdate: 'subagent_completed',
        subagentId: 'child-grok-1',
      });
      return { text: 'delegated result', stopReason: 'completed' };
    });

    const response = await adapter.askNativeSubagent('delegate this', {
      profile: 'explorer',
      effort: 'high',
    });

    expect(response.text).toBe('delegated result');
    expect(response.metadata?.nativeSubagent).toMatchObject({
      provider: 'grok',
      parentThreadId: 'sess-grok-1',
      threadId: 'child-grok-1',
      mode: 'acp-native-subagent',
      effort: 'high',
      proof: 'spawn_subagent_invoked_and_completed',
    });
    expect(adapter.getRuntimeInfo()).toMatchObject({
      supportsNativeSubagents: true,
      lastNativeSubagent: expect.objectContaining({ mode: 'acp-native-subagent' }),
    });
  });

  it('requires invocation and completion after a spawn_subagent permission request', async () => {
    const adapter = primedAdapter();
    vi.spyOn(grokParent, 'ask').mockImplementation(async () => {
      await (
        adapter as unknown as { requestPermission: (params: unknown) => Promise<unknown> }
      ).requestPermission({
        toolCall: { name: 'spawn_subagent', title: 'Spawn subagent' },
        options: [{ kind: 'allow_once', optionId: 'allow-once' }],
      });
      (
        adapter as unknown as { handleSessionUpdate: (params: unknown) => void }
      ).handleSessionUpdate({ sessionUpdate: 'tool_call', toolCall: { name: 'spawn_subagent' } });
      (
        adapter as unknown as { handleSessionUpdate: (params: unknown) => void }
      ).handleSessionUpdate({ sessionUpdate: 'subagent_completed' });
      return { text: 'delegated via permission', stopReason: 'completed' };
    });

    const response = await adapter.askNativeSubagent('delegate this', { profile: 'implementer' });
    expect(response.text).toBe('delegated via permission');
    expect(response.metadata?.nativeSubagent).toMatchObject({ provider: 'grok' });
  });

  it('does not treat available-commands advertising spawn_subagent as observation', async () => {
    const adapter = primedAdapter();
    vi.spyOn(grokParent, 'ask').mockImplementation(async () => {
      (
        adapter as unknown as { handleSessionUpdate: (params: unknown) => void }
      ).handleSessionUpdate({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'spawn_subagent' }],
      });
      return { text: 'parent-only', stopReason: 'completed' };
    });

    await expect(adapter.askNativeSubagent('delegate this')).rejects.toThrow(
      '[SUBAGENT_UNAVAILABLE] Grok did not provide both native spawn_subagent invocation and completion evidence.'
    );
  });

  it('is disabled by GROK_SUBAGENTS=0', async () => {
    process.env.GROK_SUBAGENTS = '0';
    const adapter = primedAdapter();
    const ask = vi.spyOn(grokParent, 'ask');

    await expect(adapter.askNativeSubagent('delegate this')).rejects.toThrow(
      '[SUBAGENT_UNAVAILABLE] Grok native subagents are disabled by GROK_SUBAGENTS=0.'
    );
    expect(ask).not.toHaveBeenCalled();
    expect(adapter.getRuntimeInfo().supportsNativeSubagents).toBe(false);
  });

  it('fails closed when the ACP session is not booted', async () => {
    const adapter = new GrokAdapter();
    await expect(adapter.askNativeSubagent('delegate this')).rejects.toThrow(
      '[SUBAGENT_UNAVAILABLE] Grok ACP session is not booted.'
    );
  });
});

import { describe, expect, it, vi } from 'vitest';

import { HarnessSubagentDispatcher } from './agent-dispatch.js';
import {
  CodexCliReasoningBackend,
  type CodexHarnessSession,
} from './codex-cli-reasoning-backend.js';
import { AgyCliBackend, type AgyHarnessSession } from './agy-cli-backend.js';
import { ShellGrokCliBackend, type GrokHarnessSession } from './shell-grok-cli-backend.js';

describe('native Codex Luna WorkItem routing', () => {
  it('selects the native adopter, routes gpt-5.6-luna, and records execution proof', async () => {
    const session: CodexHarnessSession = {
      boot: vi.fn(async () => undefined),
      ask: vi.fn(),
      askNativeSubagent: vi.fn(async (_prompt, options) => ({
        text: 'native-workitem-result',
        stopReason: 'completed',
        metadata: {
          nativeSubagent: {
            provider: 'codex',
            model: 'gpt-5.6-luna',
            threadId: 'thread-workitem-native-luna',
            turnId: 'turn-workitem-native-luna',
            mode: 'native-subagent',
            profile: options?.profile,
          },
        },
      })),
    };
    const backend = new CodexCliReasoningBackend({
      model: 'openai:gpt-5.6-luna',
      harnessSession: session,
    });
    const delegateTask = vi
      .spyOn(backend, 'delegateTask')
      .mockRejectedValue(new Error('plain delegateTask must not be called'));
    const dispatcher = new HarnessSubagentDispatcher();

    const result = await dispatcher.dispatch(
      'Execute the native WorkItem task.',
      'workitem:witem-native-luna-01',
      backend,
      { profile: 'implementer', model: 'gpt-5.6-luna' }
    );

    expect(result).toBe('native-workitem-result');
    expect(session.boot).toHaveBeenCalledOnce();
    expect(session.askNativeSubagent).toHaveBeenCalledOnce();
    expect(session.ask).not.toHaveBeenCalled();
    expect(delegateTask).not.toHaveBeenCalled();
    expect((backend as unknown as { options: { model?: string } }).options.model).toBe(
      'openai:gpt-5.6-luna'
    );
    expect(backend.getNativeSubagentAdopter?.().getInfo?.()).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-luna',
      threadId: 'thread-workitem-native-luna',
      turnId: 'turn-workitem-native-luna',
      mode: 'native-subagent',
    });
  });
});

describe('native AGY WorkItem routing', () => {
  it('selects the native AGY adopter, routes native subagent, and records execution proof', async () => {
    const session: AgyHarnessSession = {
      boot: vi.fn(async () => undefined),
      ask: vi.fn(),
      askNativeSubagent: vi.fn(async (_prompt, options) => ({
        text: 'native-agy-workitem-result',
        stopReason: 'completed',
        metadata: {
          nativeSubagent: {
            provider: 'agy',
            threadId: 'thread-workitem-native-agy',
            mode: 'agy-subagent-adopter',
            profile: options?.profile,
          },
        },
      })),
    };
    const backend = new AgyCliBackend({
      bin: 'agy',
      model: 'agy',
      harnessSession: session,
    });
    const dispatcher = new HarnessSubagentDispatcher();

    const result = await dispatcher.dispatch(
      'Execute the native AGY WorkItem task.',
      'workitem:witem-native-agy-01',
      backend,
      { profile: 'implementer' }
    );

    expect(result).toBe('native-agy-workitem-result');
    expect(session.boot).toHaveBeenCalledOnce();
    expect(session.askNativeSubagent).toHaveBeenCalledOnce();
    expect(backend.getNativeSubagentAdopter?.().getInfo?.()).toMatchObject({
      provider: 'agy',
      threadId: 'thread-workitem-native-agy',
      mode: 'agy-subagent-adopter',
    });
  });
});

describe('native Grok WorkItem routing', () => {
  it('selects the grok-acp adopter, routes native spawn_subagent, and records execution proof', async () => {
    const session: GrokHarnessSession = {
      boot: vi.fn(async () => undefined),
      ask: vi.fn(),
      askNativeSubagent: vi.fn(async (_prompt, options) => ({
        text: 'native-grok-workitem-result',
        stopReason: 'completed',
        metadata: {
          nativeSubagent: {
            provider: 'grok',
            parentThreadId: 'sess-grok-parent',
            threadId: 'sess-grok-parent',
            forked: false,
            mode: 'acp-native-subagent',
            effort: 'medium',
            profile: options?.profile,
          },
        },
      })),
    };
    const backend = new ShellGrokCliBackend({
      bin: 'grok',
      model: 'grok-4.6',
      harnessSession: session,
    });
    const dispatcher = new HarnessSubagentDispatcher();

    const result = await dispatcher.dispatch(
      'Execute the native Grok WorkItem task.',
      'workitem:witem-native-grok-01',
      backend,
      { profile: 'implementer' }
    );

    expect(result).toBe('native-grok-workitem-result');
    expect(session.boot).toHaveBeenCalledOnce();
    expect(session.askNativeSubagent).toHaveBeenCalledOnce();
    expect(session.ask).not.toHaveBeenCalled();
    expect(backend.getNativeSubagentAdopter?.().id).toBe('grok-acp');
    expect(backend.getNativeSubagentAdopter?.().getInfo?.()).toMatchObject({
      provider: 'grok',
      threadId: 'sess-grok-parent',
      mode: 'acp-native-subagent',
    });
  });
});

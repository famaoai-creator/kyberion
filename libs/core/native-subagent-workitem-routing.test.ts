import { describe, expect, it, vi } from 'vitest';

import { HarnessSubagentDispatcher } from './agent-dispatch.js';
import {
  CodexCliReasoningBackend,
  type CodexHarnessSession,
} from './codex-cli-reasoning-backend.js';

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

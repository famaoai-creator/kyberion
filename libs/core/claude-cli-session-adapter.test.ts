import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  ClaudeCliSessionAdapter,
  normalizeClaudeStreamMessage,
} from './claude-cli-session-adapter.js';

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  kill: ReturnType<typeof vi.fn>;
}

function createFakeChild(): { child: FakeChild; written: string[] } {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  const written: string[] = [];
  child.stdin.on('data', (chunk) => written.push(String(chunk)));
  queueMicrotask(() => child.emit('spawn'));
  return { child, written };
}

function emit(child: FakeChild, ...messages: Record<string, unknown>[]): void {
  for (const message of messages) child.stdout.write(`${JSON.stringify(message)}\n`);
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-1',
  agents: ['kyberion-explorer', 'general-purpose'],
  tools: ['Task'],
};

function toolUse(input: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'assistant',
    session_id: 'sess-1',
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'tool_use', name: 'Agent', id: 'toolu_1', input }],
    },
  };
}

const TOOL_USE = toolUse({
  subagent_type: 'kyberion-explorer',
  prompt: 'do it',
  run_in_background: false,
});

const SUBAGENT_SCOPED = {
  type: 'user',
  session_id: 'sess-1',
  parent_tool_use_id: 'toolu_1',
  message: { content: [{ type: 'text', text: 'do it' }] },
};

function toolResult(
  content: unknown,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: 'user',
    session_id: 'sess-1',
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content, ...extra }],
    },
  };
}

const TOOL_RESULT = toolResult([
  { type: 'text', text: 'REPORT' },
  { type: 'text', text: 'agentId: aad358c5 (internal)\n<usage>subagent_tokens: 2604</usage>' },
]);

/** Verbatim shape of the CLI's background launch acknowledgement. */
const ASYNC_LAUNCH_ACK = toolResult([
  {
    type: 'text',
    text: 'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it.)\nagentId: aa3c9030 (internal ID)\nThe agent is working in the background.',
  },
]);

function result(text: string): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 'sess-1',
    result: text,
    is_error: false,
  };
}

describe('ClaudeCliSessionAdapter (CN-01)', () => {
  it('normalizes stream envelopes and rejects malformed protocol shapes', () => {
    expect(normalizeClaudeStreamMessage([])).toBeUndefined();
    expect(normalizeClaudeStreamMessage({ type: 'result', result: 42 })).toBeUndefined();
    expect(
      normalizeClaudeStreamMessage({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_1', input: { run_in_background: 1 } }],
        },
      })
    ).toMatchObject({ type: 'assistant', message: { content: [] } });
    expect(
      normalizeClaudeStreamMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        agents: ['kyberion-explorer'],
        message: { content: [{ type: 'text', text: 'ok' }, []] },
      })
    ).toMatchObject({
      type: 'system',
      agents: ['kyberion-explorer'],
      message: { content: [{ type: 'text', text: 'ok' }] },
    });
  });

  describe('session argv', () => {
    it('builds a deterministic stream-json session for the explorer tier', () => {
      const args = new ClaudeCliSessionAdapter({
        profile: 'explorer',
        model: 'sonnet',
      }).buildArgs();

      expect(args.slice(0, 8)).toEqual([
        '-p',
        '--verbose',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--model',
        'sonnet',
      ]);
      // The parent may only delegate — never do the work itself.
      expect(args[args.indexOf('--tools') + 1]).toBe('Task');
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
      // Deterministic agent surface: no user/project agent definitions.
      expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
      expect(args).toContain('--disallowedTools');

      const definitions = JSON.parse(args[args.indexOf('--agents') + 1]);
      expect(Object.keys(definitions)).toEqual(['kyberion-explorer']);
      expect(definitions['kyberion-explorer'].tools).toEqual(['Read', 'Grep', 'Glob']);
    });

    it('carries the implementer permission projection and the effort flag', () => {
      const args = new ClaudeCliSessionAdapter({
        profile: 'implementer',
        effort: 'high',
      }).buildArgs();

      expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
      expect(args[args.indexOf('--effort') + 1]).toBe('high');
      expect(args).not.toContain('--disallowedTools');
    });
  });

  describe('native delegation observation', () => {
    it('resolves with the sub-agent report and provider-observed metadata', async () => {
      const { child, written } = createFakeChild();
      const adapter = new ClaudeCliSessionAdapter({
        profile: 'explorer',
        spawnProcess: () => child as never,
      });

      const pending = adapter.askNativeSubagent('delegate this');
      await flush();
      expect(JSON.parse(written.join(''))).toMatchObject({
        type: 'user',
        message: { content: [{ type: 'text', text: 'delegate this' }] },
      });

      emit(child, INIT, TOOL_USE, SUBAGENT_SCOPED, TOOL_RESULT, result('REPORT (paraphrased)'));
      const response = await pending;

      // The sub-agent's own tool_result body wins over the parent's framing,
      // and the CLI's internal agentId / usage trailer is dropped.
      expect(response.text).toBe('REPORT');
      expect(response.metadata?.nativeSubagent).toMatchObject({
        provider: 'claude',
        mode: 'cli-stream-json',
        threadId: 'sess-1',
        turnId: 'toolu_1',
        subagentType: 'kyberion-explorer',
      });
      expect(adapter.getRuntimeInfo()).toMatchObject({
        supportsNativeSubagents: true,
        sessionId: 'sess-1',
      });
    });

    it('fails closed when the turn never started a native sub-agent', async () => {
      const { child } = createFakeChild();
      const adapter = new ClaudeCliSessionAdapter({
        profile: 'explorer',
        spawnProcess: () => child as never,
      });

      const pending = adapter.askNativeSubagent('delegate this');
      await flush();
      emit(child, INIT, result('I did it myself'));

      await expect(pending).rejects.toThrow(
        '[SUBAGENT_UNAVAILABLE] claude CLI session returned no observable native sub-agent delegation'
      );
    });

    it('fails closed on a background delegation instead of returning the launch ack', async () => {
      const { child } = createFakeChild();
      const adapter = new ClaudeCliSessionAdapter({
        profile: 'explorer',
        spawnProcess: () => child as never,
      });

      const pending = adapter.askNativeSubagent('delegate this');
      await flush();
      // Observed background flow: the tool_result is an immediate ack, scoped
      // messages still appear, and the turn result is the parent's "launched"
      // sentence — never the sub-agent's report.
      emit(
        child,
        INIT,
        toolUse({ subagent_type: 'kyberion-explorer', run_in_background: true }),
        ASYNC_LAUNCH_ACK,
        SUBAGENT_SCOPED,
        result('Agent launched in the background. You will be notified when it completes.')
      );

      await expect(pending).rejects.toThrow(
        '[SUBAGENT_UNAVAILABLE] claude CLI sub-agent "kyberion-explorer" ran in the background'
      );
    });

    it('treats the async launch ack as background even when the tool_use omits the flag', async () => {
      const { child } = createFakeChild();
      const adapter = new ClaudeCliSessionAdapter({
        profile: 'explorer',
        spawnProcess: () => child as never,
      });

      const pending = adapter.askNativeSubagent('delegate this');
      await flush();
      emit(
        child,
        INIT,
        toolUse({ subagent_type: 'kyberion-explorer', run_in_background: false }),
        ASYNC_LAUNCH_ACK,
        result('Agent launched.')
      );

      await expect(pending).rejects.toThrow('ran in the background');
    });

    it('fails closed when a non-governed built-in sub-agent is started', async () => {
      const { child } = createFakeChild();
      const adapter = new ClaudeCliSessionAdapter({
        profile: 'explorer',
        spawnProcess: () => child as never,
      });

      const pending = adapter.askNativeSubagent('delegate this');
      await flush();
      emit(
        child,
        INIT,
        toolUse({ subagent_type: 'general-purpose', run_in_background: false }),
        toolResult([{ type: 'text', text: 'did it with full tools' }]),
        result('done')
      );

      await expect(pending).rejects.toThrow(
        '[SUBAGENT_UNAVAILABLE] claude CLI session started the non-governed sub-agent "general-purpose" instead of "kyberion-explorer".'
      );
    });

    it('fails closed when the delegation tool_result is an error', async () => {
      const { child } = createFakeChild();
      const adapter = new ClaudeCliSessionAdapter({
        profile: 'explorer',
        spawnProcess: () => child as never,
      });

      const pending = adapter.askNativeSubagent('delegate this');
      await flush();
      emit(
        child,
        INIT,
        TOOL_USE,
        toolResult([{ type: 'text', text: 'permission denied' }], { is_error: true }),
        result('the sub-agent failed')
      );

      await expect(pending).rejects.toThrow(
        '[SUBAGENT_UNAVAILABLE] claude CLI sub-agent "kyberion-explorer" returned a tool error.'
      );
    });

    it('does not accept scoped messages alone as completion', async () => {
      const { child } = createFakeChild();
      const adapter = new ClaudeCliSessionAdapter({
        profile: 'explorer',
        spawnProcess: () => child as never,
      });

      const pending = adapter.askNativeSubagent('delegate this');
      await flush();
      emit(child, INIT, TOOL_USE, SUBAGENT_SCOPED, result('looks done to me'));

      await expect(pending).rejects.toThrow(
        '[SUBAGENT_UNAVAILABLE] claude CLI sub-agent "kyberion-explorer" did not return a completed report'
      );
    });

    it('fails closed when the governed agent definition was not registered', async () => {
      const { child } = createFakeChild();
      const adapter = new ClaudeCliSessionAdapter({
        profile: 'explorer',
        spawnProcess: () => child as never,
      });

      const pending = adapter.askNativeSubagent('delegate this');
      await flush();
      emit(child, { ...INIT, agents: ['general-purpose'] });

      await expect(pending).rejects.toThrow(
        '[SUBAGENT_UNAVAILABLE] claude CLI session did not register the governed sub-agent "kyberion-explorer"'
      );
    });

    it('fails closed when init reports no agent list at all (registration unconfirmable)', async () => {
      const { child } = createFakeChild();
      const adapter = new ClaudeCliSessionAdapter({
        profile: 'explorer',
        spawnProcess: () => child as never,
      });

      const pending = adapter.askNativeSubagent('delegate this');
      await flush();
      emit(child, { type: 'system', subtype: 'init', session_id: 'sess-1' });

      await expect(pending).rejects.toThrow(
        '[SUBAGENT_UNAVAILABLE] claude CLI session did not register the governed sub-agent "kyberion-explorer" (available: none reported)'
      );
    });

    it('surfaces an error result as unavailable rather than as an answer', async () => {
      const { child } = createFakeChild();
      const adapter = new ClaudeCliSessionAdapter({
        profile: 'explorer',
        spawnProcess: () => child as never,
      });

      const pending = adapter.askNativeSubagent('delegate this');
      await flush();
      emit(child, INIT, {
        type: 'result',
        subtype: 'error_during_execution',
        session_id: 'sess-1',
        is_error: true,
        result: 'boom',
      });

      await expect(pending).rejects.toThrow('[SUBAGENT_UNAVAILABLE] claude CLI turn failed');
    });
  });

  describe('lifecycle', () => {
    it('fails the pending turn when the session process exits', async () => {
      const { child } = createFakeChild();
      const adapter = new ClaudeCliSessionAdapter({
        profile: 'explorer',
        spawnProcess: () => child as never,
      });

      const pending = adapter.askNativeSubagent('delegate this');
      await flush();
      child.stderr.write('auth expired');
      child.emit('close', 1, null);

      await expect(pending).rejects.toThrow('[SUBAGENT_UNAVAILABLE] claude CLI session exited');
    });

    it('enforces the per-turn wall-clock budget', async () => {
      const { child } = createFakeChild();
      const adapter = new ClaudeCliSessionAdapter({
        profile: 'explorer',
        timeoutMs: 20,
        spawnProcess: () => child as never,
      });

      await expect(adapter.askNativeSubagent('delegate this')).rejects.toThrow(
        '[SUBAGENT_UNAVAILABLE] claude CLI turn timed out'
      );
    });

    it('interrupts the provider turn on abort (GE-06)', async () => {
      const { child, written } = createFakeChild();
      const adapter = new ClaudeCliSessionAdapter({
        profile: 'explorer',
        spawnProcess: () => child as never,
      });
      const controller = new AbortController();

      const pending = adapter.askNativeSubagent('delegate this', { signal: controller.signal });
      await flush();
      controller.abort();

      await expect(pending).rejects.toThrow('[SUBAGENT_UNAVAILABLE] claude CLI turn aborted');
      await flush();
      expect(written.join('')).toContain('"subtype":"interrupt"');
    });
  });
});

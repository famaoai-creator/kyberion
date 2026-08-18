import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./core.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const recordGovernanceAction = vi.fn();
vi.mock('./kill-switch.js', () => ({
  recordGovernanceAction: (...args: unknown[]) => recordGovernanceAction(...args),
}));

const execResult = vi.hoisted(() => ({
  value: { stdout: '', stderr: '', status: 0 } as {
    stdout: string;
    stderr: string;
    status: number | null;
  },
}));
vi.mock('./secure-io.js', () => ({
  safeExecResult: vi.fn(() => execResult.value),
  safeExistsSync: vi.fn(() => false),
  safeReadFile: vi.fn(() => '{}'),
  safeAppendFileSync: vi.fn(),
  safeMkdir: vi.fn(),
}));

import { executeAdfSteps } from './adf-engine.js';
import {
  LifecycleHookEngine,
  fireLifecycleHooks,
  loadLifecycleHookEngine,
  resetDefaultLifecycleHookEngine,
} from './lifecycle-hook-engine.js';
import { registerExternalLifecycleHooks } from './external-hook-bridge.js';
import {
  getDefaultWorkerEventStream,
  resetDefaultWorkerEventStream,
} from './worker-event-stream.js';

beforeEach(() => {
  recordGovernanceAction.mockClear();
  resetDefaultWorkerEventStream();
  resetDefaultLifecycleHookEngine();
});

afterEach(() => {
  resetDefaultWorkerEventStream();
  resetDefaultLifecycleHookEngine();
});

describe('LifecycleHookEngine', () => {
  it('runs matching hooks in parallel and aggregates block decisions', async () => {
    const engine = new LifecycleHookEngine();
    const order: string[] = [];
    engine.register({
      id: 'allow-hook',
      event: 'pre_tool_use',
      matcher: '^shell:',
      handler: async () => {
        order.push('allow');
      },
    });
    engine.register({
      id: 'block-hook',
      event: 'pre_tool_use',
      matcher: 'shell:exec',
      handler: () => ({ block: true, reason: 'dangerous op' }),
    });
    engine.register({
      id: 'other-event',
      event: 'post_tool_use',
      handler: () => ({ block: true, reason: 'never fires here' }),
    });

    const outcome = await engine.fire('pre_tool_use', { matcher_value: 'shell:exec' });
    expect(outcome.blocked).toBe(true);
    expect(outcome.reasons).toEqual(['dangerous op']);
    expect(order).toEqual(['allow']);

    const unmatched = await engine.fire('pre_tool_use', { matcher_value: 'io:read' });
    expect(unmatched.blocked).toBe(false);
  });

  it('is fail-open: a throwing hook never blocks or throws', async () => {
    const engine = new LifecycleHookEngine();
    engine.register({
      id: 'broken',
      event: 'pre_tool_use',
      handler: () => {
        throw new Error('hook exploded');
      },
    });
    const outcome = await engine.fire('pre_tool_use', { matcher_value: 'anything' });
    expect(outcome.blocked).toBe(false);
    expect(outcome.failedHooks).toEqual(['broken']);
  });

  it('records block telemetry even when a sibling hook and the stream fail (carve-out)', async () => {
    const engine = new LifecycleHookEngine();
    engine.register({
      id: 'broken-sibling',
      event: 'pre_tool_use',
      handler: () => {
        throw new Error('sibling exploded');
      },
    });
    engine.register({
      id: 'security-block',
      event: 'pre_tool_use',
      handler: () => ({ block: true, reason: 'policy violation' }),
    });
    getDefaultWorkerEventStream().subscribe(() => {
      throw new Error('broken consumer');
    });

    const outcome = await fireLifecycleHooks(engine, 'pre_tool_use', {
      matcher_value: 'apply:secrets',
    });
    expect(outcome.blocked).toBe(true);
    expect(recordGovernanceAction).toHaveBeenCalledWith(
      'lifecycle-hooks',
      'hook_block',
      expect.stringContaining('policy violation'),
      true
    );
  });

  it('projects block decisions onto the worker event stream', async () => {
    const engine = new LifecycleHookEngine();
    engine.register({
      id: 'blocker',
      event: 'pre_tool_use',
      handler: () => ({ block: true, reason: 'nope' }),
    });
    const seen: string[] = [];
    getDefaultWorkerEventStream().subscribe((event) => seen.push(event.type));

    await fireLifecycleHooks(engine, 'pre_tool_use', { matcher_value: 'x' });
    expect(seen).toEqual(['governance_action']);
  });

  it('command hooks block on exit code 2 or a JSON block decision', async () => {
    const engine = new LifecycleHookEngine();
    engine.register({ id: 'cmd', event: 'pre_tool_use', command: ['guard-cmd'] });

    execResult.value = { stdout: '', stderr: 'denied by guard', status: 2 };
    const byExit = await engine.fire('pre_tool_use', { matcher_value: 'x' });
    expect(byExit.blocked).toBe(true);
    expect(byExit.reasons[0]).toContain('denied by guard');

    execResult.value = {
      stdout: JSON.stringify({ decision: 'block', reason: 'json says no' }),
      stderr: '',
      status: 0,
    };
    const byJson = await engine.fire('pre_tool_use', { matcher_value: 'x' });
    expect(byJson.blocked).toBe(true);
    expect(byJson.reasons).toEqual(['json says no']);

    execResult.value = { stdout: 'not json', stderr: '', status: 0 };
    const allowed = await engine.fire('pre_tool_use', { matcher_value: 'x' });
    expect(allowed.blocked).toBe(false);
  });

  it('rejects unknown events and hooks without handler/command at registration', () => {
    const engine = new LifecycleHookEngine();
    expect(() =>
      engine.register({ id: 'bad-event', event: 'not_an_event' as never, handler: () => undefined })
    ).toThrow('[HOOK_CONFIG]');
    expect(() => engine.register({ id: 'empty', event: 'stop' })).toThrow('[HOOK_CONFIG]');
  });

  it('accepts task_settled as the terminal lifecycle receipt event', async () => {
    const engine = new LifecycleHookEngine();
    const seen: string[] = [];
    engine.register({
      id: 'settlement-receipt',
      event: 'task_settled',
      handler: (_event, payload) => {
        seen.push(String(payload.status));
      },
    });
    const outcome = await engine.fire('task_settled', {
      matcher_value: 'pipeline:demo',
      status: 'succeeded',
    });
    expect(outcome.blocked).toBe(false);
    expect(seen).toEqual(['succeeded']);
  });

  it('accepts before_agent_start and exposes system prompt options to hooks', async () => {
    const engine = new LifecycleHookEngine();
    const seen: unknown[] = [];
    engine.register({
      id: 'prompt-policy',
      event: 'before_agent_start',
      handler: (_event, payload) => {
        seen.push(payload.systemPromptOptions);
        return { block: false, additional_context: 'use the governed context pack' };
      },
    });
    const outcome = await engine.fire('before_agent_start', {
      matcher_value: 'TASK-1',
      systemPromptOptions: { taskId: 'TASK-1', promptVisibility: 'ledgered' },
    });
    expect(outcome).toMatchObject({
      blocked: false,
      additionalContext: ['use the governed context pack'],
    });
    expect(seen).toEqual([{ taskId: 'TASK-1', promptVisibility: 'ledgered' }]);
  });

  it('projects ask as a fail-closed disposition and keeps block precedence', async () => {
    const engine = new LifecycleHookEngine();
    engine.register({
      id: 'ask',
      event: 'pre_tool_use',
      handler: () => ({ block: false, decision: 'ask', reason: 'operator required' }),
    });
    const asked = await engine.fire('pre_tool_use', { matcher_value: 'tool:x' });
    expect(asked).toMatchObject({ blocked: true, asked: true, decision: 'ask' });
    expect(asked.reasons).toEqual(['operator required']);

    engine.register({
      id: 'block',
      event: 'pre_tool_use',
      handler: () => ({ block: true, reason: 'deny wins' }),
    });
    const blocked = await engine.fire('pre_tool_use', { matcher_value: 'tool:x' });
    expect(blocked).toMatchObject({ blocked: true, asked: false, decision: 'block' });
    expect(blocked.reasons).toContain('deny wins');
  });

  it('latches a sticky block until an explicit clearHalt', async () => {
    const engine = new LifecycleHookEngine({ stickyHalt: true });
    const denyDispose = engine.register({
      id: 'deny-once',
      event: 'pre_tool_use',
      handler: () => ({ block: true, reason: 'operator denied this tool' }),
    });
    const denied = await engine.fire('pre_tool_use', { matcher_value: 'tool:x' });
    expect(denied).toMatchObject({ blocked: true, decision: 'block' });
    expect(engine.isHalted).toBe(true);

    const dispose = engine.register({
      id: 'later-allow',
      event: 'pre_tool_use',
      handler: () => ({ block: false }),
    });
    dispose();
    const stillDenied = await engine.fire('pre_tool_use', { matcher_value: 'tool:y' });
    expect(stillDenied.reasons).toEqual(['sticky lifecycle halt: operator denied this tool']);

    engine.clearHalt();
    expect(engine.isHalted).toBe(false);
    denyDispose();
    const afterClear = await engine.fire('pre_tool_use', { matcher_value: 'tool:z' });
    expect(afterClear.blocked).toBe(false);
  });

  it('exposes an idle barrier for in-flight async hooks', async () => {
    const engine = new LifecycleHookEngine();
    let release!: () => void;
    const hookFinished = new Promise<void>((resolve) => {
      release = resolve;
    });
    engine.register({
      id: 'slow',
      event: 'pre_tool_use',
      handler: async () => {
        await hookFinished;
        return { block: false };
      },
    });
    const fire = engine.fire('pre_tool_use', { matcher_value: 'tool:x' });
    let idle = false;
    const idlePromise = engine.whenIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    release();
    await fire;
    await idlePromise;
    expect(idle).toBe(true);
  });

  it('registers Claude grouped hooks and disposes the external batch', async () => {
    const engine = new LifecycleHookEngine();
    const bridge = registerExternalLifecycleHooks(
      engine,
      {
        PreToolUse: [
          {
            matcher: '^Bash$',
            hooks: [{ type: 'command', command: 'kyberion-hook' }],
          },
        ],
      },
      'claude-code'
    );
    expect(bridge.registered).toBe(1);
    expect(engine.hookCountFor('pre_tool_use')).toBe(1);
    await bridge.dispose();
    expect(engine.hookCountFor('pre_tool_use')).toBe(0);
  });

  it('registers normalized Codex hooks with the same lifecycle vocabulary', async () => {
    const engine = new LifecycleHookEngine();
    const bridge = registerExternalLifecycleHooks(
      engine,
      {
        hooks: [
          { event: 'tool_call', matcher: '^fs:', command: ['codex-hook'] },
          { event: 'agent_end', command: ['codex-settled-hook'] },
        ],
      },
      'codex'
    );
    expect(bridge.registered).toBe(2);
    expect(engine.hookCountFor('pre_tool_use')).toBe(1);
    expect(engine.hookCountFor('task_settled')).toBe(1);
    await bridge.dispose();
  });

  it('maps external Claude permission deny and ask responses', async () => {
    const engine = new LifecycleHookEngine();
    registerExternalLifecycleHooks(
      engine,
      { PreToolUse: [{ hooks: [{ type: 'command', command: ['external-hook'] }] }] },
      'claude-code'
    );
    execResult.value = {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: 'ask',
          permissionDecisionReason: 'needs approval',
        },
      }),
      stderr: '',
      status: 0,
    };
    const asked = await engine.fire('pre_tool_use', { matcher_value: 'Bash' });
    expect(asked).toMatchObject({ blocked: true, asked: true, decision: 'ask' });
    execResult.value = {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: 'deny',
          permissionDecisionReason: 'policy denied',
        },
      }),
      stderr: '',
      status: 0,
    };
    const denied = await engine.fire('pre_tool_use', { matcher_value: 'Bash' });
    expect(denied).toMatchObject({ blocked: true, decision: 'block' });
    expect(denied.reasons).toEqual(['policy denied']);
  });

  it('aggregates partial result patches for post-tool middleware', async () => {
    const engine = new LifecycleHookEngine();
    engine.register({
      id: 'patch-result',
      event: 'post_tool_use',
      handler: () => ({ block: false, result_patch: { redacted: true, source: 'hook' } }),
    });
    const outcome = await engine.fire('post_tool_use', { matcher_value: 'tool:read' });
    expect(outcome).toMatchObject({
      blocked: false,
      resultPatch: { redacted: true, source: 'hook' },
    });
  });

  it('loadLifecycleHookEngine skips malformed config entries (fail-open)', () => {
    const engine = loadLifecycleHookEngine('/nonexistent/hooks.json');
    expect(engine.hookCountFor('pre_tool_use')).toBe(0);
  });
});

describe('adf-engine stepGate integration (KC-04 acceptance)', () => {
  const passthroughHandlers = {
    capture: async (_op: string, _params: unknown, ctx: any) => ctx,
    transform: async (_op: string, _params: unknown, ctx: any) => ctx,
    apply: async (_op: string, _params: unknown, ctx: any) => ctx,
  };

  it('a blocking pre_tool_use hook aborts the run (not recoverable via on_error)', async () => {
    const engine = new LifecycleHookEngine();
    engine.register({
      id: 'no-secrets',
      event: 'pre_tool_use',
      matcher: 'secrets',
      handler: () => ({ block: true, reason: 'secrets op forbidden' }),
    });

    await expect(
      executeAdfSteps(
        [
          { type: 'capture', op: 'fetch', params: {} },
          { type: 'apply', op: 'apply:secrets', params: {}, on_error: 'skip' } as never,
        ],
        {},
        {
          maxSteps: 10,
          timeoutMs: 5_000,
          stepGate: async (step) => {
            const outcome = await fireLifecycleHooks(engine, 'pre_tool_use', {
              matcher_value: `${step.op}`,
            });
            return outcome.blocked ? { blocked: true, reasons: outcome.reasons } : undefined;
          },
        },
        passthroughHandlers
      )
    ).rejects.toThrow('[HOOK_BLOCKED]');
    expect(recordGovernanceAction).toHaveBeenCalledTimes(1);
  });

  it('a broken hook engine degrades to allow through fireLifecycleHooks (fail-open end to end)', async () => {
    const engine = new LifecycleHookEngine();
    engine.register({
      id: 'broken',
      event: 'pre_tool_use',
      handler: () => {
        throw new Error('hook infrastructure down');
      },
    });
    const result = await executeAdfSteps(
      [{ type: 'apply', op: 'notify', params: {} }],
      {},
      {
        maxSteps: 10,
        timeoutMs: 5_000,
        stepGate: async (step) => {
          const outcome = await fireLifecycleHooks(engine, 'pre_tool_use', {
            matcher_value: `${step.op}`,
          });
          return outcome.blocked ? { blocked: true, reasons: outcome.reasons } : undefined;
        },
      },
      passthroughHandlers
    );
    expect(result.status).toBe('succeeded');
  });
});

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

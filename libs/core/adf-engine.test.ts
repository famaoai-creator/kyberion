import { describe, expect, it, vi } from 'vitest';
import { executeAdfSteps, skipAdfStep } from './adf-engine.js';

vi.mock('./core.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe('executeAdfSteps', () => {
  it('executes declared graph nodes with a completion-driven frontier', async () => {
    const events: string[] = [];
    const result = await executeAdfSteps(
      [
        { id: 'slow', type: 'capture', op: 'slow', params: {}, depends_on: [] } as any,
        { id: 'fast', type: 'capture', op: 'fast', params: {}, depends_on: [] } as any,
        {
          id: 'slow-child',
          type: 'transform',
          op: 'slow-child',
          params: {},
          depends_on: ['slow'],
        } as any,
        {
          id: 'fast-child',
          type: 'transform',
          op: 'fast-child',
          params: {},
          depends_on: ['fast'],
        } as any,
      ],
      {},
      { maxSteps: 10, timeoutMs: 10_000, maxConcurrency: 2 },
      {
        capture: async (op, _params, ctx) => {
          events.push(`start:${op}`);
          await new Promise((resolve) => setTimeout(resolve, op === 'slow' ? 20 : 1));
          events.push(`end:${op}`);
          return { ...ctx, [op]: true };
        },
        transform: async (op, _params, ctx) => {
          events.push(`start:${op}`);
          return { ...ctx, [op]: true };
        },
        apply: async (_op, _params, ctx) => ctx,
      }
    );

    expect(result.status).toBe('succeeded');
    expect(result.context).toMatchObject({
      slow: true,
      fast: true,
      'fast-child': true,
      'slow-child': true,
    });
    expect(events.indexOf('start:fast-child')).toBeLessThan(events.indexOf('end:slow'));
  });

  it('honors explicit step resource claims without inferring ownership claims', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const execution = executeAdfSteps(
      [
        {
          id: 'first',
          type: 'capture',
          op: 'first',
          params: {},
          depends_on: [],
          resource_claims: ['workspace:shared'],
        } as any,
        {
          id: 'second',
          type: 'capture',
          op: 'second',
          params: {},
          depends_on: [],
          resource_claims: ['workspace:shared'],
        } as any,
      ],
      {},
      { maxSteps: 10, timeoutMs: 10_000, maxConcurrency: 2 },
      {
        capture: async (op, _params, ctx) => {
          events.push(`start:${op}`);
          if (op === 'first') await firstReleased;
          events.push(`end:${op}`);
          return { ...ctx, [op]: true };
        },
        transform: async (_op, _params, ctx) => ctx,
        apply: async (_op, _params, ctx) => ctx,
      }
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(['start:first']);
    releaseFirst();
    await execution;
    expect(events).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  it('derives conservative typed file claims for graph steps without explicit claims', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const execution = executeAdfSteps(
      [
        {
          id: 'read-a',
          type: 'apply',
          op: 'file:read_file',
          params: { path: 'shared.txt' },
          depends_on: [],
        } as any,
        {
          id: 'read-b',
          type: 'apply',
          op: 'file:read_file',
          params: { path: 'shared.txt' },
          depends_on: [],
        } as any,
      ],
      {},
      { maxSteps: 10, timeoutMs: 10_000, maxConcurrency: 2 },
      {
        capture: async (_op, _params, ctx) => ctx,
        transform: async (_op, _params, ctx) => ctx,
        apply: async (op, _params, ctx) => {
          events.push(`start:${op}`);
          if (op === 'file:read_file') {
            if (events.length === 1) await firstReleased;
          }
          events.push(`end:${op}`);
          return ctx;
        },
      }
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(['start:file:read_file']);
    releaseFirst();
    await execution;
    expect(events).toEqual([
      'start:file:read_file',
      'end:file:read_file',
      'start:file:read_file',
      'end:file:read_file',
    ]);
  });

  it('executes nested control steps with a shared step budget', async () => {
    const result = await executeAdfSteps(
      [
        { type: 'capture', op: 'seed', params: { value: 'alpha' } },
        {
          type: 'control',
          op: 'if',
          params: {
            condition: { enabled: true },
            then: [{ type: 'transform', op: 'mark', params: { suffix: '-done' } }],
          },
        },
        { type: 'apply', op: 'finish', params: {} },
      ],
      {},
      { maxSteps: 10, timeoutMs: 10_000 },
      {
        capture: async (_op, params, ctx) => ({ ...ctx, captured: params.value }),
        transform: async (_op, params, ctx) => ({
          ...ctx,
          transformed: `${ctx.captured}${params.suffix}`,
        }),
        apply: async (_op, _params, ctx) => ({ ...ctx, applied: true }),
        control: async (_op, params, ctx, runSteps) => {
          const nested = await runSteps(params.then, ctx);
          if (nested.status === 'failed') {
            throw new Error(
              nested.results.find((result) => result.status === 'failed')?.error || 'nested failure'
            );
          }
          return nested.context;
        },
      }
    );

    expect(result.status).toBe('succeeded');
    expect(result.total_steps).toBe(4);
    expect(result.context).toMatchObject({
      captured: 'alpha',
      transformed: 'alpha-done',
      applied: true,
    });
    expect(result.results).toHaveLength(3);
  });

  it('enforces the configured step budget', async () => {
    await expect(
      executeAdfSteps(
        [
          { type: 'capture', op: 'one', params: {} },
          { type: 'capture', op: 'two', params: {} },
        ],
        {},
        { maxSteps: 1, timeoutMs: 10_000 },
        {
          capture: async (_op, _params, ctx) => ctx,
          transform: async (_op, _params, ctx) => ctx,
          apply: async (_op, _params, ctx) => ctx,
        }
      )
    ).rejects.toThrow('[SAFETY_LIMIT]');
  });

  it('records skipped control-flow steps explicitly', async () => {
    const result = await executeAdfSteps(
      [
        {
          type: 'control',
          op: 'if',
          params: {
            condition: { enabled: false },
            then: [{ type: 'apply', op: 'finish', params: {} }],
          },
        },
      ],
      {},
      { maxSteps: 10, timeoutMs: 10_000 },
      {
        capture: async (_op, _params, ctx) => ctx,
        transform: async (_op, _params, ctx) => ctx,
        apply: async (_op, _params, ctx) => ctx,
        control: async (_op, _params, ctx) => skipAdfStep(ctx, 'branch did not match'),
      }
    );

    expect(result.status).toBe('succeeded');
    expect(result.results).toEqual([{ op: 'if', status: 'skipped' }]);
  });

  it('records skipped apply steps (AR-01 Phase C: run_pipeline routes non-control ops through apply)', async () => {
    const result = await executeAdfSteps(
      [{ type: 'apply', op: 'maybe_run', params: {} }],
      {},
      { maxSteps: 10, timeoutMs: 10_000 },
      {
        capture: async (_op, _params, ctx) => ctx,
        transform: async (_op, _params, ctx) => ctx,
        apply: async (_op, _params, ctx) => skipAdfStep(ctx, 'rejected by before hook'),
      }
    );

    expect(result.status).toBe('succeeded');
    expect(result.results).toEqual([{ op: 'maybe_run', status: 'skipped' }]);
  });

  it('propagates nested control failures to the parent pipeline', async () => {
    const result = await executeAdfSteps(
      [
        {
          type: 'control',
          op: 'if',
          params: {
            condition: { enabled: true },
            then: [{ type: 'capture', op: 'fail', params: {} }],
          },
        },
      ],
      {},
      { maxSteps: 10, timeoutMs: 10_000 },
      {
        capture: async (_op, _params, ctx) => {
          throw new Error('nested capture failed');
        },
        transform: async (_op, _params, ctx) => ctx,
        apply: async (_op, _params, ctx) => ctx,
        control: async (_op, params, ctx, runSteps) => {
          const nested = await runSteps(params.then, ctx);
          if (nested.status === 'failed') {
            throw new Error(
              nested.results.find((result) => result.status === 'failed')?.error || 'nested failure'
            );
          }
          return nested.context;
        },
      }
    );

    expect(result.status).toBe('failed');
    expect(result.results).toEqual([
      { op: 'if', status: 'failed', error: 'nested capture failed' },
    ]);
  });

  it('honors the resolveVars override and label option', async () => {
    const result = await executeAdfSteps(
      [{ type: 'capture', op: 'capture_name', params: { value: '{{name}}' } }],
      { name: 'world' },
      {
        maxSteps: 10,
        timeoutMs: 10_000,
        label: '[CUSTOM]',
        resolveVars: (value, ctx) => (value === '{{name}}' ? ctx.name : value),
      },
      {
        capture: async (_op, params, ctx, resolve) => ({
          ...ctx,
          capture_name: resolve(params.value),
        }),
        transform: async (_op, _params, ctx) => ctx,
        apply: async (_op, _params, ctx) => ctx,
      }
    );

    expect(result.status).toBe('succeeded');
    expect(result.context.capture_name).toBe('world');
  });

  it('recovers failed steps via on_error: skip', async () => {
    const result = await executeAdfSteps(
      [
        { type: 'capture', op: 'boom', params: {}, on_error: { strategy: 'skip' } } as any,
        { type: 'apply', op: 'finish', params: {} },
      ],
      {},
      { maxSteps: 10, timeoutMs: 10_000 },
      {
        capture: async () => {
          throw new Error('capture exploded');
        },
        transform: async (_op, _params, ctx) => ctx,
        apply: async (_op, _params, ctx) => ({ ...ctx, applied: true }),
      }
    );

    expect(result.status).toBe('succeeded');
    expect(result.results).toEqual([
      { op: 'boom', status: 'recovered' },
      { op: 'finish', status: 'success' },
    ]);
    expect(result.context.applied).toBe(true);
    expect(result.context._error).toMatchObject({ message: 'capture exploded' });
  });

  it('runs on_error fallback steps through the engine with the shared budget', async () => {
    const result = await executeAdfSteps(
      [
        {
          type: 'capture',
          op: 'boom',
          params: {},
          on_error: {
            strategy: 'fallback',
            fallback: [{ type: 'transform', op: 'salvage', params: {} }],
          },
        } as any,
      ],
      {},
      { maxSteps: 10, timeoutMs: 10_000 },
      {
        capture: async () => {
          throw new Error('capture exploded');
        },
        transform: async (_op, _params, ctx) => ({ ...ctx, salvaged: true }),
        apply: async (_op, _params, ctx) => ctx,
      }
    );

    expect(result.status).toBe('succeeded');
    expect(result.results).toEqual([{ op: 'boom', status: 'recovered' }]);
    expect(result.context.salvaged).toBe(true);
    // failed step + fallback step both count against the budget
    expect(result.total_steps).toBe(2);
  });

  it('fails the step when the on_error fallback pipeline itself fails', async () => {
    const result = await executeAdfSteps(
      [
        {
          type: 'capture',
          op: 'boom',
          params: {},
          on_error: {
            strategy: 'fallback',
            fallback: [{ type: 'transform', op: 'also-boom', params: {} }],
          },
        } as any,
      ],
      {},
      { maxSteps: 10, timeoutMs: 10_000 },
      {
        capture: async () => {
          throw new Error('capture exploded');
        },
        transform: async () => {
          throw new Error('fallback exploded');
        },
        apply: async (_op, _params, ctx) => ctx,
      }
    );

    expect(result.status).toBe('failed');
    expect(result.results).toEqual([{ op: 'boom', status: 'failed', error: 'capture exploded' }]);
  });

  it('fires beforeStep/afterStep hooks for top-level and nested steps', async () => {
    const events: string[] = [];
    const result = await executeAdfSteps(
      [
        {
          type: 'control',
          op: 'if',
          params: {
            condition: { enabled: true },
            then: [{ type: 'capture', op: 'inner', params: {} }],
          },
        },
        { type: 'capture', op: 'boom', params: {}, on_error: { strategy: 'skip' } } as any,
      ],
      {},
      { maxSteps: 10, timeoutMs: 10_000 },
      {
        capture: async (op, _params, ctx) => {
          if (op === 'boom') throw new Error('nope');
          return ctx;
        },
        transform: async (_op, _params, ctx) => ctx,
        apply: async (_op, _params, ctx) => ctx,
        control: async (_op, params, ctx, runSteps) => {
          const nested = await runSteps(params.then, ctx);
          if (nested.status === 'failed') throw new Error('nested failure');
          return nested.context;
        },
      },
      {
        beforeStep: (step) => events.push(`before:${step.op}`),
        afterStep: (step, _n, _ctx, outcome) => events.push(`after:${step.op}:${outcome.status}`),
      }
    );

    expect(result.status).toBe('succeeded');
    expect(events).toEqual([
      'before:if',
      'before:inner',
      'after:inner:success',
      'after:if:success',
      'before:boom',
      'after:boom:recovered',
    ]);
  });

  describe('tool-call repeat governor (KC-01)', () => {
    const passthroughHandlers = {
      capture: async (_op: string, _params: any, ctx: any) => ctx,
      transform: async (_op: string, _params: any, ctx: any) => ctx,
      apply: async (_op: string, _params: any, ctx: any) => ctx,
    };

    it('force-stops a linear stream of identical calls and records the stop', async () => {
      const onRepeatForceStop = vi.fn();
      const steps = Array.from({ length: 15 }, () => ({
        type: 'apply' as const,
        op: 'notify',
        params: { channel: 'ops', message: 'ping' },
      }));

      await expect(
        executeAdfSteps(
          steps,
          {},
          { maxSteps: 100, timeoutMs: 10_000, onRepeatForceStop },
          passthroughHandlers
        )
      ).rejects.toThrow('[TOOL_CALL_REPEAT]');
      expect(onRepeatForceStop).toHaveBeenCalledTimes(1);
      expect(onRepeatForceStop.mock.calls[0][1].streak).toBe(12);
    });

    it('does not force-stop identical calls declared inside an explicit loop op', async () => {
      const result = await executeAdfSteps(
        [
          {
            type: 'control',
            op: 'core:while',
            params: {
              iterations: 20,
              body: [{ type: 'capture', op: 'poll', params: { target: 'status' } }],
            },
          },
        ],
        {},
        { maxSteps: 100, timeoutMs: 10_000 },
        {
          ...passthroughHandlers,
          control: async (_op, params, ctx, runSteps) => {
            let current = ctx;
            for (let i = 0; i < params.iterations; i += 1) {
              const nested = await runSteps(params.body, current);
              if (nested.status === 'failed') throw new Error('nested failure');
              current = nested.context;
            }
            return current;
          },
        }
      );
      expect(result.status).toBe('succeeded');
    });

    it('does not count template steps resolving to different values as repeats', async () => {
      const steps = Array.from({ length: 15 }, () => ({
        type: 'apply' as const,
        op: 'notify',
        params: { message: '{{tick}}' },
      }));
      let tick = 0;
      const result = await executeAdfSteps(
        steps,
        {},
        {
          maxSteps: 100,
          timeoutMs: 10_000,
          resolveVars: (value) => {
            tick += 1;
            return { ...value, message: `tick-${tick}` };
          },
        },
        passthroughHandlers
      );
      expect(result.status).toBe('succeeded');
      expect(result.total_steps).toBe(15);
    });
  });
});

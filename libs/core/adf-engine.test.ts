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
});

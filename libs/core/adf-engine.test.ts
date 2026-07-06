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
});

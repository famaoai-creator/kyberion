import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actuatorModuleLoader, executeSuperPipeline } from './index.js';

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
    safeReadFile: vi.fn((filePath: string) =>
      String(filePath).includes('macro')
        ? JSON.stringify({ steps: [{ op: 'system:log', params: { message: 'from macro' } }] })
        : ''
    ),
    safeWriteFile: vi.fn(),
    safeExec: vi.fn().mockReturnValue(''),
    safeExistsSync: vi.fn().mockReturnValue(true),
    safeUnlinkSync: vi.fn(),
  };
});

describe('super-nerve engine', () => {
  beforeEach(async () => {
    const { safeExec, safeReadFile } = await import('@agent/core');
    vi.mocked(safeExec).mockReturnValue('');
    vi.mocked(safeReadFile).mockImplementation((filePath: string) =>
      String(filePath).includes('macro')
        ? JSON.stringify({ steps: [{ op: 'system:log', params: { message: 'from macro' } }] })
        : ''
    );
    // Hermetic in-process dispatch: stub the loader so no built actuator
    // module is imported from dist during unit tests.
    vi.spyOn(actuatorModuleLoader, 'load')
      .mockClear()
      .mockImplementation(async () => ({
        handleAction: async (input: { steps: Array<{ op: string }>; context: any }) => {
          const op = input.steps?.[0]?.op;
          if (op === 'does_not_exist') {
            return {
              status: 'failed',
              results: [{ op, status: 'failed', error: `Unknown op: ${op}` }],
              context: input.context,
            };
          }
          return {
            status: 'succeeded',
            results: [{ op, status: 'success' }],
            context: { ...input.context, probed: true, context_path: 'should/be/stripped.json' },
          };
        },
      }));
  });

  it('runs core control flow through the shared adf engine', async () => {
    const result = await executeSuperPipeline(
      [
        {
          op: 'core:if',
          params: {
            condition: { from: 'flag', operator: 'eq', value: true },
            then: [{ op: 'system:log', params: { message: 'branch taken' } }],
          },
        },
      ],
      { flag: true }
    );

    expect(result.status).toBe('succeeded');
    expect(result.results).toHaveLength(1);
    expect(result.context.flag).toBe(true);
  });

  it('marks false branches as skipped instead of silently succeeding', async () => {
    const result = await executeSuperPipeline(
      [
        {
          op: 'core:if',
          params: {
            condition: { from: 'flag', operator: 'eq', value: true },
            then: [{ op: 'system:log', params: { message: 'branch taken' } }],
          },
        },
      ],
      { flag: false }
    );

    expect(result.status).toBe('succeeded');
    expect(result.results).toEqual([{ op: 'if', status: 'skipped' }]);
  });

  it('propagates nested control failures to the parent pipeline', async () => {
    const result = await executeSuperPipeline(
      [
        {
          op: 'core:if',
          params: {
            condition: { from: 'flag', operator: 'eq', value: true },
            then: [{ op: 'system:does_not_exist', params: {} }],
          },
        },
      ],
      { flag: true }
    );

    expect(result.status).toBe('failed');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      op: 'if',
      status: 'failed',
    });
  });

  it('dispatches actuator ops in-process and merges the returned context', async () => {
    const result = await executeSuperPipeline(
      [{ op: 'network:fetch', params: { url: 'https://example.com' } }],
      { seed: 1 }
    );

    expect(result.status).toBe('succeeded');
    expect(result.context.probed).toBe(true);
    expect(result.context.seed).toBe(1);
    // actuator-internal bookkeeping must not leak into the parent context
    expect(result.context.context_path).toBeUndefined();
    expect(actuatorModuleLoader.load).toHaveBeenCalledTimes(1);
  });

  it('resolves core call/include through the canonical resolver', async () => {
    const result = await executeSuperPipeline([
      { op: 'core:call', params: { path: 'macros/sample.json' } },
    ]);

    expect(result.status).toBe('succeeded');
    expect(result.results).toHaveLength(1);
  });
});

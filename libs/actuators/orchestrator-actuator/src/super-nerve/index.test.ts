import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actuatorModuleLoader, executeSuperPipeline } from './index.js';

const { attemptAutonomousRepairMock, loadPipelineAdfAtPathMock } = vi.hoisted(() => ({
  attemptAutonomousRepairMock: vi.fn(),
  loadPipelineAdfAtPathMock: vi.fn((filePath: string) => {
    if (String(filePath).includes('retryable')) {
      return {
        steps: [
          {
            op: 'network:fetch',
            params: { url: 'https://repaired.example.com' },
          },
        ],
      };
    }
    throw new Error(`unexpected pipeline path: ${filePath}`);
  }),
}));

const readJsonMock = vi.hoisted(() =>
  vi.fn((filePath: string) => {
    if (String(filePath).includes('macro')) {
      return { steps: [{ op: 'system:log', params: { message: 'from macro' } }] };
    }
    throw new Error(`unexpected JSON path: ${filePath}`);
  })
);

vi.mock('@agent/core/autonomous-repair', () => ({
  attemptAutonomousRepair: attemptAutonomousRepairMock,
}));

vi.mock('@agent/core/pipeline-contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/pipeline-contract')>()),
  loadPipelineAdfAtPath: loadPipelineAdfAtPathMock,
}));

vi.mock('@agent/core/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/foundation')>()),
  readJson: readJsonMock,
}));

vi.mock('@agent/core/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/core')>();
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
  };
});

vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  safeReadFile: vi.fn((filePath: string) =>
    String(filePath).includes('macro')
      ? JSON.stringify({ steps: [{ op: 'system:log', params: { message: 'from macro' } }] })
      : ''
  ),
  safeExistsSync: vi.fn().mockReturnValue(true),
  safeLstat: vi.fn(() => ({ isFile: () => true, isSymbolicLink: () => false })),
  safeWriteFile: vi.fn(),
  safeExec: vi.fn().mockReturnValue(''),
  safeUnlinkSync: vi.fn(),
}));

describe('super-nerve engine', () => {
  beforeEach(async () => {
    attemptAutonomousRepairMock.mockReset().mockResolvedValue(false);
    loadPipelineAdfAtPathMock.mockReset().mockImplementation((filePath: string) => ({
      steps: [
        {
          op: 'network:fetch',
          params: {
            url: String(filePath).includes('retryable')
              ? 'https://repaired.example.com'
              : 'https://unexpected.example.com',
          },
        },
      ],
    }));
    const { safeExec, safeReadFile } = await import('@agent/core/secure-io');
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

  it('passes the durable pipeline path into canonical repair from a failed nerve step', async () => {
    attemptAutonomousRepairMock.mockResolvedValue(true);
    const seenUrls: unknown[] = [];
    vi.mocked(actuatorModuleLoader.load).mockImplementation(async () => ({
      handleAction: async (input: {
        steps: Array<{ op: string; params?: Record<string, unknown> }>;
        context: Record<string, unknown>;
      }) => {
        seenUrls.push(input.steps[0]?.params?.url);
        if (seenUrls.length === 1) {
          return {
            status: 'failed',
            results: [
              {
                op: input.steps[0]?.op,
                status: 'failed',
                error: 'operation returned no data',
              },
            ],
            context: input.context,
          };
        }
        return {
          status: seenUrls[1] === 'https://repaired.example.com' ? 'succeeded' : 'failed',
          results: [
            {
              op: input.steps[0]?.op,
              status: seenUrls[1] === 'https://repaired.example.com' ? 'success' : 'failed',
              ...(seenUrls[1] === 'https://repaired.example.com'
                ? {}
                : { error: 'operation returned no data' }),
            },
          ],
          context: input.context,
        };
      },
    }));

    await executeSuperPipeline(
      [{ op: 'network:fetch', params: { url: 'https://example.com' } }],
      {},
      { pipelinePath: 'pipelines/retryable.json', trustResolved: true }
    );

    expect(attemptAutonomousRepairMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelinePath: 'pipelines/retryable.json',
        trustResolved: true,
      })
    );
    expect(seenUrls).toEqual(['https://example.com', 'https://repaired.example.com']);
  });

  it('does not retry when a repaired pipeline fails the canonical ADF loader', async () => {
    attemptAutonomousRepairMock.mockResolvedValue(true);
    loadPipelineAdfAtPathMock.mockImplementationOnce(() => {
      throw new Error('Invalid pipeline ADF: repaired step is malformed');
    });
    let dispatchCount = 0;
    vi.mocked(actuatorModuleLoader.load).mockImplementation(async () => ({
      handleAction: async (input: {
        steps: Array<{ op: string }>;
        context: Record<string, unknown>;
      }) => {
        dispatchCount += 1;
        return {
          status: 'failed',
          results: [
            {
              op: input.steps[0]?.op,
              status: 'failed',
              error: 'operation returned no data',
            },
          ],
          context: input.context,
        };
      },
    }));

    const result = await executeSuperPipeline(
      [{ op: 'network:fetch', params: { url: 'https://example.com' } }],
      {},
      { pipelinePath: 'pipelines/retryable.json', trustResolved: true }
    );

    expect(result.status).toBe('failed');
    expect(loadPipelineAdfAtPathMock).toHaveBeenCalledTimes(1);
    expect(dispatchCount).toBe(1);
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

  it('runs the standard preflight waterfall before in-process actuator dispatch', async () => {
    await expect(
      executeSuperPipeline([{ op: 'network:fetch', params: { _approval_required: true } }])
    ).rejects.toThrow('[OP_PREFLIGHT_ASK]');
    expect(actuatorModuleLoader.load).not.toHaveBeenCalled();
  });

  it('resolves core call/include through the canonical resolver', async () => {
    const result = await executeSuperPipeline(
      [{ op: 'core:call', params: { path: 'macros/sample.json' } }],
      {},
      { trustResolved: true }
    );

    expect(result.status).toBe('succeeded');
    expect(result.results).toHaveLength(1);
  });

  it('fails closed when a core include contains dangerous JSON keys', async () => {
    const { safeReadFile } = await import('@agent/core/secure-io');
    vi.mocked(safeReadFile).mockReturnValue('{"constructor":{"polluted":true}}');

    const result = await executeSuperPipeline(
      [{ op: 'core:call', params: { path: 'macros/dangerous.json' } }],
      {},
      { trustResolved: true }
    );

    expect(result.status).toBe('failed');
    expect(result.results[0]?.error).toContain('dangerous JSON key');
  });

  it('blocks core call/include until the caller supplies a trust decision', async () => {
    const result = await executeSuperPipeline([
      { op: 'core:call', params: { path: 'macros/sample.json' } },
    ]);

    expect(result.status).toBe('failed');
    expect(result.results[0]).toMatchObject({
      op: 'call',
      status: 'failed',
      error: expect.stringContaining('[TRUST_REQUIRED]'),
    });
  });

  it('rejects core call/include paths outside the repository', async () => {
    const result = await executeSuperPipeline(
      [{ op: 'core:call', params: { path: '../outside-repository.json' } }],
      {},
      { trustResolved: true }
    );

    expect(result.status).toBe('failed');
    expect(result.results[0]).toMatchObject({
      op: 'call',
      status: 'failed',
      error: expect.stringContaining('[TRUST_REQUIRED]'),
    });
  });
});

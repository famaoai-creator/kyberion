import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeSuperPipeline } from './index.js';

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

  it('resolves core call/include through the canonical resolver', async () => {
    const result = await executeSuperPipeline([
      { op: 'core:call', params: { path: 'macros/sample.json' } },
    ]);

    expect(result.status).toBe('succeeded');
    expect(result.results).toHaveLength(1);
  });
});

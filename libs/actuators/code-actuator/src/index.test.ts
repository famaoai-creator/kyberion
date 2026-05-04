import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import { handleAction } from './index.js';

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    safeReadFile: vi.fn().mockReturnValue('{}'),
    safeWriteFile: vi.fn(),
    safeMkdir: vi.fn(),
    safeExistsSync: vi.fn().mockReturnValue(false),
    safeReaddir: vi.fn().mockReturnValue([]),
    safeLstat: vi.fn().mockReturnValue({ isDirectory: () => false }),
    safeExec: vi.fn().mockReturnValue(''),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
    derivePipelineStatus: actual.derivePipelineStatus,
    resolveVars: actual.resolveVars,
    evaluateCondition: actual.evaluateCondition,
    resolveWriteArtifactSpec: actual.resolveWriteArtifactSpec,
    pathResolver: {
      rootDir: vi.fn().mockReturnValue('/mock/root'),
      resolve: vi.fn((p: string) => `/mock/root/${p}`),
    },
  };
});

vi.mock('@agent/core/fs-utils', () => ({
  getAllFiles: vi.fn().mockReturnValue([]),
}));

describe('code-actuator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleAction()', () => {
    // Happy path: pipeline action handles empty steps successfully
    it('pipeline actionで空のstepsを処理できる', async () => {
      const result = await handleAction({ action: 'pipeline', steps: [] });
      expect(result.status).toBe('succeeded');
      expect(result.results).toHaveLength(0);
    });

    // Error case: reconcile action throws when strategy_path does not exist
    it('reconcile actionでstrategy_pathが存在しない場合エラーをスロー', async () => {
      const { safeExistsSync } = await import('@agent/core');
      vi.mocked(safeExistsSync).mockReturnValue(false);

      await expect(
        handleAction({ action: 'reconcile', strategy_path: 'nonexistent.json' })
      ).rejects.toThrow('Strategy not found');
    });

    // Error case: unsupported action falls through to executePipeline (does not throw)
    // The implementation routes any non-'reconcile' action to executePipeline,
    // so an unsupported action with empty steps returns succeeded.
    it('サポートされていないactionはpipelineとして処理される（エラーなし）', async () => {
      const result = await handleAction({ action: 'invalid' as any, steps: [] });
      // Falls through to executePipeline with empty steps → succeeded
      expect(result.status).toBe('succeeded');
    });

    // Error case: when KYBERION_ALLOW_UNSAFE_SHELL=false, the shell operator returns an error with [SECURITY] prefix
    it('KYBERION_ALLOW_UNSAFE_SHELL=falseの場合、shellオペレーターが[SECURITY]プレフィックスのエラーを返す', async () => {
      // KYBERION_ALLOW_UNSAFE_SHELL is not 'true' in test environment, so shell is disabled
      const result = await handleAction({
        action: 'pipeline',
        steps: [
          {
            type: 'capture',
            op: 'shell',
            params: { cmd: 'echo test', export_as: 'output' },
          },
        ],
      });
      expect(result.status).toBe('failed');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe('failed');
      expect(result.results[0].error).toContain('[SECURITY]');
    });

    it('max_steps超過時に[SAFETY_LIMIT]エラーをスロー', async () => {
      const steps = Array.from({ length: 3 }, (_, i) => ({
        type: 'apply' as const,
        op: 'log',
        params: { message: `step ${i}` },
      }));

      await expect(
        handleAction({ action: 'pipeline', steps, options: { max_steps: 2 } })
      ).rejects.toThrow('[SAFETY_LIMIT]');
    });

    it('ステップが失敗した場合、残りのステップを実行しない', async () => {
      const { safeReadFile } = await import('@agent/core');
      vi.mocked(safeReadFile).mockImplementationOnce(() => {
        throw new Error('File not found');
      });

      const result = await handleAction({
        action: 'pipeline',
        steps: [
          { type: 'capture', op: 'read_file', params: { path: 'missing.txt' } },
          { type: 'capture', op: 'read_file', params: { path: 'other.txt' } }, // 実行されない
        ],
      });

      expect(result.status).toBe('failed');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe('failed');
    });

    describe('capture ops', () => {
      it('read_file でファイルを読み込む', async () => {
        const { safeReadFile } = await import('@agent/core');
        vi.mocked(safeReadFile).mockReturnValueOnce('code file content');

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'capture',
              op: 'read_file',
              params: { path: 'src/index.ts', export_as: 'source_code' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.source_code).toBe('code file content');
      });

      it('glob_files でファイル一覧を取得する', async () => {
        const { getAllFiles } = await import('@agent/core/fs-utils');
        vi.mocked(getAllFiles).mockReturnValueOnce([
          '/mock/root/src/file1.ts',
          '/mock/root/src/file2.ts',
        ]);

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'capture',
              op: 'glob_files',
              params: { dir: 'src', ext: '.ts', export_as: 'ts_files' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.ts_files).toBeDefined();
        expect(Array.isArray(result.context.ts_files)).toBe(true);
      });
    });

    describe('apply ops', () => {
      it('log オペレーターはメッセージをログに記録する', async () => {
        const { logger } = await import('@agent/core');

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'log',
              params: { message: 'code actuator log test' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
          expect.stringContaining('code actuator log test')
        );
      });

      it('write_file でファイルを書き込む', async () => {
        const { safeWriteFile, safeExistsSync } = await import('@agent/core');
        vi.mocked(safeExistsSync).mockReturnValue(true);

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'write_file',
              params: { path: 'output/result.txt', content: 'generated content' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(safeWriteFile).toHaveBeenCalled();
      });
    });

    describe('control ops', () => {
      it('if オペレーターで条件が真の場合にthenブランチを実行する', async () => {
        // Use real evaluateCondition with actual context values
        const result = await handleAction({
          action: 'pipeline',
          context: { flag: true },
          steps: [
            {
              type: 'control',
              op: 'if',
              params: {
                condition: { left: '{{flag}}', op: 'eq', right: true },
                then: [{ type: 'apply', op: 'log', params: { message: 'condition was true' } }],
              },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
      });

      it('if オペレーターで条件が偽の場合にelseブランチを実行する', async () => {
        const result = await handleAction({
          action: 'pipeline',
          context: { flag: false },
          steps: [
            {
              type: 'control',
              op: 'if',
              params: {
                condition: { left: '{{flag}}', op: 'eq', right: true },
                then: [{ type: 'apply', op: 'log', params: { message: 'condition was true' } }],
                else: [{ type: 'apply', op: 'log', params: { message: 'condition was false' } }],
              },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
      });
    });

    describe('context_path', () => {
      it('context_pathが指定された場合、コンテキストを保存する', async () => {
        const { safeWriteFile } = await import('@agent/core');

        const result = await handleAction({
          action: 'pipeline',
          context: { context_path: 'active/shared/tmp/code-ctx.json' },
          steps: [{ type: 'apply', op: 'log', params: { message: 'test' } }],
        });

        expect(result.status).toBe('succeeded');
        expect(safeWriteFile).toHaveBeenCalledWith(
          expect.stringContaining('code-ctx.json'),
          expect.any(String)
        );
      });
    });

    // Feature: project-quality-improvement, Property 1: パイプライン結果の構造不変条件
    describe('Property 1: パイプライン結果の構造不変条件', () => {
      it('任意のstepsに対してstatusは常にsucceeded|failedのいずれか', async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.array(
              fc.record({
                type: fc.constantFrom('capture', 'apply') as fc.Arbitrary<'capture' | 'apply'>,
                op: fc.constantFrom('read_file', 'glob_files', 'log', 'write_file'),
                params: fc.record({ path: fc.string({ minLength: 1 }) }),
              }),
              { maxLength: 5 }
            ),
            async (steps) => {
              const result = await handleAction({ action: 'pipeline', steps });
              expect(['succeeded', 'failed']).toContain(result.status);
            }
          ),
          { numRuns: 100 }
        );
      });
    });

    // Feature: project-quality-improvement, Property 2: SAFETY_LIMITエラーの一貫性
    describe('Property 2: SAFETY_LIMITエラーの一貫性', () => {
      it('max_steps超過時は常に[SAFETY_LIMIT]プレフィックスのエラー', async () => {
        /**
         * Validates: Requirements 1.6
         */
        await fc.assert(
          fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (maxSteps) => {
            const steps = Array.from({ length: maxSteps + 1 }, (_, i) => ({
              type: 'apply' as const,
              op: 'log',
              params: { message: `step ${i}` },
            }));

            await expect(
              handleAction({ action: 'pipeline', steps, options: { max_steps: maxSteps } })
            ).rejects.toThrow('[SAFETY_LIMIT]');
          }),
          { numRuns: 100 }
        );
      });
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAction } from './index.js';

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    safeReadFile: vi.fn().mockReturnValue('{}'),
    safeWriteFile: vi.fn(),
    safeAppendFileSync: vi.fn(),
    safeMkdir: vi.fn(),
    safeExistsSync: vi.fn().mockReturnValue(false),
    safeReaddir: vi.fn().mockReturnValue([]),
    safeExec: vi.fn().mockReturnValue(''),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
    derivePipelineStatus: actual.derivePipelineStatus,
    resolveVars: actual.resolveVars,
    evaluateCondition: actual.evaluateCondition,
    getPathValue: actual.getPathValue,
    resolveWriteArtifactSpec: actual.resolveWriteArtifactSpec,
    withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    pathResolver: {
      rootDir: vi.fn().mockReturnValue('/mock/root'),
      rootResolve: vi.fn((p: string) => `/mock/root/${p}`),
      resolve: vi.fn((p: string) => `/mock/root/${p}`),
      knowledge: vi.fn((p: string) => `/mock/knowledge/${p}`),
      sharedExports: vi.fn((p: string) => `/mock/exports/${p}`),
    },
  };
});

vi.mock('@agent/core/fs-utils', () => ({
  getAllFiles: vi.fn().mockReturnValue([]),
}));

vi.mock('@agent/core/cli-utils', () => ({
  createStandardYargs: vi.fn().mockReturnValue({
    option: vi.fn().mockReturnThis(),
    parseSync: vi.fn().mockReturnValue({ input: 'input.json' }),
  }),
}));

vi.mock('./decision-ops.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./decision-ops.js')>();
  return {
    ...actual,
    dispatchDecisionOp: vi.fn().mockResolvedValue({ handled: false, ctx: {} }),
  };
});

describe('wisdom-actuator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleAction()', () => {
    it('pipeline actionで空のstepsを処理できる', async () => {
      const result = await handleAction({ action: 'pipeline', steps: [] });
      expect(result.status).toBe('succeeded');
      expect(result.results).toHaveLength(0);
    });

    it('reconcile actionでstrategy_pathが存在しない場合エラーをスロー', async () => {
      const { safeExistsSync } = await import('@agent/core');
      vi.mocked(safeExistsSync).mockReturnValue(false);

      await expect(
        handleAction({ action: 'reconcile', strategy_path: 'nonexistent.json' })
      ).rejects.toThrow('Strategy not found');
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
        vi.mocked(safeReadFile).mockReturnValueOnce('file content here');

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'capture',
              op: 'read_file',
              params: { path: 'some/file.txt', export_as: 'file_content' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.file_content).toBe('file content here');
      });

      it('read_json でJSONファイルを読み込む', async () => {
        const { safeReadFile } = await import('@agent/core');
        vi.mocked(safeReadFile).mockReturnValueOnce(JSON.stringify({ key: 'value' }));

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'capture',
              op: 'read_json',
              params: { path: 'some/file.json', export_as: 'json_data' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.json_data).toEqual({ key: 'value' });
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
              params: { dir: 'src', ext: '.ts', export_as: 'files' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.files).toBeDefined();
        expect(Array.isArray(result.context.files)).toBe(true);
      });
    });

    describe('transform ops', () => {
      it('regex_extract でテキストから値を抽出する', async () => {
        const result = await handleAction({
          action: 'pipeline',
          context: { last_capture: 'Version: 1.2.3' },
          steps: [
            {
              type: 'transform',
              op: 'regex_extract',
              params: {
                from: 'last_capture',
                pattern: 'Version: (\\d+\\.\\d+\\.\\d+)',
                export_as: 'version',
              },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.version).toBe('1.2.3');
      });

      it('regex_replace でテキストを置換する', async () => {
        const result = await handleAction({
          action: 'pipeline',
          context: { last_capture: 'Hello World' },
          steps: [
            {
              type: 'transform',
              op: 'regex_replace',
              params: {
                from: 'last_capture',
                pattern: 'World',
                template: 'Kyberion',
                export_as: 'replaced',
              },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.replaced).toBe('Hello Kyberion');
      });

      it('json_query でJSONデータからパスを取得する', async () => {
        const result = await handleAction({
          action: 'pipeline',
          context: { last_capture_data: { user: { name: 'Alice' } } },
          steps: [
            {
              type: 'transform',
              op: 'json_query',
              params: { from: 'last_capture_data', path: 'user.name', export_as: 'user_name' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.user_name).toBe('Alice');
      });

      it('array_count で配列の要素数を数える', async () => {
        const result = await handleAction({
          action: 'pipeline',
          context: { items: [{ status: 'done' }, { status: 'pending' }, { status: 'done' }] },
          steps: [
            {
              type: 'transform',
              op: 'array_count',
              params: { from: 'items', where: { status: 'done' }, export_as: 'done_count' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.done_count).toBe(2);
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
              params: { message: 'test log message' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
          expect.stringContaining('test log message')
        );
      });

      it('write_file でファイルを書き込む', async () => {
        const { safeWriteFile, safeExistsSync } = await import('@agent/core');
        vi.mocked(safeExistsSync).mockReturnValue(true);

        const result = await handleAction({
          action: 'pipeline',
          context: { content: 'hello world' },
          steps: [
            {
              type: 'apply',
              op: 'write_file',
              params: { path: 'output/test.txt', content: 'hello world' },
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

      it('未知のcontrolオペレーターはコンテキストを変更しない', async () => {
        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'control',
              op: 'unknown_control_op',
              params: {},
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
          context: { context_path: 'active/shared/tmp/ctx.json' },
          steps: [{ type: 'apply', op: 'log', params: { message: 'test' } }],
        });

        expect(result.status).toBe('succeeded');
        expect(safeWriteFile).toHaveBeenCalledWith(
          expect.stringContaining('ctx.json'),
          expect.any(String)
        );
      });

      it('context_pathが存在する場合、既存のコンテキストを読み込む', async () => {
        const { safeExistsSync, safeReadFile } = await import('@agent/core');
        vi.mocked(safeExistsSync).mockReturnValue(true);
        vi.mocked(safeReadFile).mockReturnValueOnce(
          JSON.stringify({ existing_key: 'existing_value' })
        );

        const result = await handleAction({
          action: 'pipeline',
          context: { context_path: 'active/shared/tmp/ctx.json' },
          steps: [],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.existing_key).toBe('existing_value');
      });
    });
  });
});

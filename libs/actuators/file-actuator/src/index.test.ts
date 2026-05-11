import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import { handleAction } from './index.js';

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    safeReadFile: vi.fn().mockReturnValue('file content'),
    safeWriteFile: vi.fn(),
    safeMkdir: vi.fn(),
    safeExistsSync: vi.fn().mockReturnValue(false),
    safeReaddir: vi.fn().mockReturnValue([]),
    safeStat: vi.fn().mockReturnValue({
      size: 100,
      mtime: new Date(),
      isFile: () => true,
      isDirectory: () => false,
    }),
    safeExec: vi.fn().mockReturnValue(''),
    safeAppendFileSync: vi.fn(),
    safeCopyFileSync: vi.fn(),
    safeMoveSync: vi.fn(),
    safeRmSync: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
    derivePipelineStatus: actual.derivePipelineStatus,
    resolveVars: actual.resolveVars,
    evaluateCondition: actual.evaluateCondition,
    resolveWriteArtifactSpec: actual.resolveWriteArtifactSpec,
    pathResolver: {
      rootDir: vi.fn().mockReturnValue('/mock/root'),
      resolve: vi.fn((p: string) => `/mock/root/${p}`),
      rootResolve: vi.fn((p: string) => `/mock/root/${p}`),
    },
  };
});

describe('file-actuator', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { safeReadFile, safeExistsSync, safeReaddir, safeStat, safeExec } = await import('@agent/core');
    vi.mocked(safeReadFile).mockReturnValue('file content');
    vi.mocked(safeExistsSync).mockReturnValue(false);
    vi.mocked(safeReaddir).mockReturnValue([]);
    vi.mocked(safeStat).mockReturnValue({
      size: 100,
      mtime: new Date(),
      isFile: () => true,
      isDirectory: () => false,
    } as any);
    vi.mocked(safeExec).mockReturnValue('');
  });

  describe('handleAction()', () => {
    it('空のstepsで呼び出した場合、status: succeeded を返す', async () => {
      const result = await handleAction({ action: 'pipeline', steps: [] });
      expect(result.status).toBe('succeeded');
      expect(result.results).toHaveLength(0);
    });

    it('サポートされていないactionでエラーをスロー', async () => {
      await expect(handleAction({ action: 'invalid' as any, steps: [] })).rejects.toThrow(
        'Unsupported action'
      );
    });

    it('ステップが失敗した場合、残りのステップを実行しない', async () => {
      const { safeReadFile } = await import('@agent/core');
      vi.mocked(safeReadFile).mockImplementation((filePath: string) => {
        if (String(filePath).includes('manifest.json')) {
          return JSON.stringify({ recovery_policy: {} });
        }
        throw new Error('File not found');
      });

      const result = await handleAction({
        action: 'pipeline',
        steps: [
          { type: 'capture', op: 'read', params: { path: 'missing.txt' } },
          { type: 'capture', op: 'read', params: { path: 'other.txt' } }, // 実行されない
        ],
      });

      expect(result.status).toBe('failed');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe('failed');
    });

    it('max_steps超過時に[SAFETY_LIMIT]エラーをスロー', async () => {
      const steps = Array.from({ length: 3 }, (_, i) => ({
        type: 'capture' as const,
        op: 'read',
        params: { path: `file${i}.txt` },
      }));

      await expect(
        handleAction({ action: 'pipeline', steps, options: { max_steps: 2 } })
      ).rejects.toThrow('[SAFETY_LIMIT]');
    });

    describe('capture ops', () => {
    it('read でファイルを読み込む', async () => {
        const { safeReadFile } = await import('@agent/core');
        vi.mocked(safeReadFile).mockReturnValueOnce('file content here');

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'capture',
              op: 'read',
              params: { path: 'some/file.txt', export_as: 'file_content' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.file_content).toBe('file content here');
        expect((await import('@agent/core')).withRetry).toHaveBeenCalled();
      });

      it('list でディレクトリ一覧を取得する', async () => {
        const { safeReaddir } = await import('@agent/core');
        vi.mocked(safeReaddir).mockReturnValueOnce(['file1.txt', 'file2.txt'] as any);

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'capture',
              op: 'list',
              params: { path: 'some/dir', export_as: 'dir_contents' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.dir_contents).toEqual(['file1.txt', 'file2.txt']);
      });

      it('stat でファイル情報を取得する', async () => {
        const { safeStat } = await import('@agent/core');
        vi.mocked(safeStat).mockReturnValueOnce({
          size: 1024,
          mtime: new Date('2024-01-01'),
          isFile: () => true,
          isDirectory: () => false,
        } as any);

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'capture',
              op: 'stat',
              params: { path: 'some/file.txt', export_as: 'file_stat' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.file_stat.size).toBe(1024);
        expect(result.context.file_stat.isFile).toBe(true);
      });

      it('exists でファイルの存在確認をする', async () => {
        const { safeExistsSync } = await import('@agent/core');
        vi.mocked(safeExistsSync).mockReturnValueOnce(true);

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'capture',
              op: 'exists',
              params: { path: 'some/file.txt', export_as: 'file_exists' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.file_exists).toBe(true);
      });
    });

    describe('transform ops', () => {
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

      it('json_parse でJSONテキストをパースする', async () => {
        const result = await handleAction({
          action: 'pipeline',
          context: { last_capture: '{"key": "value"}' },
          steps: [
            {
              type: 'transform',
              op: 'json_parse',
              params: { from: 'last_capture', export_as: 'parsed_data' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.parsed_data).toEqual({ key: 'value' });
      });

      it('path_join でパスを結合する', async () => {
        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'transform',
              op: 'path_join',
              params: { parts: ['active', 'shared', 'tmp'], export_as: 'joined_path' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.joined_path).toContain('active');
        expect(result.context.joined_path).toContain('shared');
        expect(result.context.joined_path).toContain('tmp');
      });
    });

    describe('apply ops', () => {
      it('write でファイルを書き込む', async () => {
        const { safeWriteFile } = await import('@agent/core');

        const result = await handleAction({
          action: 'pipeline',
          context: { last_capture: 'content to write' },
          steps: [
            {
              type: 'apply',
              op: 'write',
              params: { path: 'output/result.txt' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(safeWriteFile).toHaveBeenCalled();
      });

      it('mkdir でディレクトリを作成する', async () => {
        const { safeMkdir } = await import('@agent/core');

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'mkdir',
              params: { path: 'output/new-dir' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(safeMkdir).toHaveBeenCalled();
      });

      it('delete でファイルを削除する', async () => {
        const { safeRmSync } = await import('@agent/core');

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'delete',
              params: { path: 'output/old-file.txt' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(safeRmSync).toHaveBeenCalled();
      });

      it('copy でファイルをコピーする', async () => {
        const { safeCopyFileSync } = await import('@agent/core');

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'copy',
              params: { from: 'source/file.txt', to: 'dest/file.txt' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(safeCopyFileSync).toHaveBeenCalled();
      });

      it('move でファイルを移動する', async () => {
        const { safeMoveSync } = await import('@agent/core');

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'move',
              params: { from: 'source/file.txt', to: 'dest/file.txt' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(safeMoveSync).toHaveBeenCalled();
      });

      it('append でファイルに追記する', async () => {
        const { safeAppendFileSync } = await import('@agent/core');

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'append',
              params: { path: 'output/log.txt', content: 'new log line\n' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(safeAppendFileSync).toHaveBeenCalled();
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
    });
  });

  // Feature: project-quality-improvement, Property 1: パイプライン結果の構造不変条件
  describe('Property 1: パイプライン結果の構造不変条件', () => {
    it('任意のstepsに対してstatusは常にsuccess|failedのいずれか', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              type: fc.constantFrom('capture', 'apply') as fc.Arbitrary<'capture' | 'apply'>,
              op: fc.constantFrom('read', 'write', 'mkdir', 'delete'),
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
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (maxSteps) => {
          const steps = Array.from({ length: maxSteps + 1 }, (_, i) => ({
            type: 'capture' as const,
            op: 'read',
            params: { path: `file${i}.txt` },
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

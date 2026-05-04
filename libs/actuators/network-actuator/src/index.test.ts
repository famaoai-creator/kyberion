import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import { handleAction } from './index.js';

// Mock a2a-transport to avoid module-level side effects (pathResolver.rootResolve calls)
vi.mock('./a2a-transport.js', () => ({
  sendA2AMessage: vi.fn().mockResolvedValue(undefined),
  pollA2AInbox: vi.fn().mockResolvedValue([]),
}));
vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    safeReadFile: vi.fn().mockReturnValue('file content'),
    safeWriteFile: vi.fn(),
    safeMkdir: vi.fn(),
    safeExistsSync: vi.fn().mockReturnValue(false),
    safeExec: vi.fn().mockReturnValue(''),
    secureFetch: vi.fn().mockResolvedValue({ status: 200, data: {} }),
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
      resolve: vi.fn((p: string) => `/mock/root/${p}`),
      rootResolve: vi.fn((p: string) => `/mock/root/${p}`),
      sharedTmp: vi.fn((p: string) => `/mock/tmp/${p}`),
      knowledge: vi.fn((p: string) => `/mock/knowledge/${p}`),
    },
  };
});

describe('network-actuator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      const { secureFetch } = await import('@agent/core');
      vi.mocked(secureFetch).mockRejectedValueOnce(new Error('Network error'));

      const result = await handleAction({
        action: 'pipeline',
        steps: [
          { type: 'capture', op: 'fetch', params: { url: 'https://example.com' } },
          { type: 'capture', op: 'fetch', params: { url: 'https://other.com' } }, // 実行されない
        ],
      });

      expect(result.status).toBe('failed');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe('failed');
    });

    it('max_steps超過時に[SAFETY_LIMIT]エラーをスロー', async () => {
      const { secureFetch } = await import('@agent/core');
      vi.mocked(secureFetch).mockResolvedValue({ status: 200, data: {} });

      const steps = Array.from({ length: 3 }, (_, i) => ({
        type: 'capture' as const,
        op: 'fetch',
        params: { url: `https://example.com/${i}` },
      }));

      await expect(
        handleAction({ action: 'pipeline', steps, options: { max_steps: 2 } })
      ).rejects.toThrow('[SAFETY_LIMIT]');
    });

    describe('capture ops', () => {
      it('fetch でHTTPリクエストを実行する', async () => {
        const { secureFetch } = await import('@agent/core');
        vi.mocked(secureFetch).mockResolvedValueOnce({ status: 200, data: { result: 'ok' } });

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'capture',
              op: 'fetch',
              params: { url: 'https://api.example.com/data', export_as: 'api_response' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.api_response).toBeDefined();
        expect(result.context.api_response.status).toBe(200);
      });

      it('fetch でPOSTリクエストを実行する', async () => {
        const { secureFetch } = await import('@agent/core');
        vi.mocked(secureFetch).mockResolvedValueOnce({ status: 201, data: { id: 1 } });

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'capture',
              op: 'fetch',
              params: {
                url: 'https://api.example.com/items',
                method: 'POST',
                data: { name: 'test' },
                export_as: 'create_response',
              },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.create_response.status).toBe(201);
      });

      it('shell オペレーターはKYBERION_ALLOW_UNSAFE_SHELL=falseの場合エラーをスロー', async () => {
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
        expect(result.results[0].error).toContain('[SECURITY]');
      });

      it('a2a_poll でメッセージを取得する', async () => {
        const { pollA2AInbox } = await import('./a2a-transport.js');
        vi.mocked(pollA2AInbox).mockResolvedValueOnce([{ id: 'msg-1', content: 'hello' }] as any);

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'capture',
              op: 'a2a_poll',
              params: { export_as: 'messages' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.messages).toHaveLength(1);
      });
    });

    describe('transform ops', () => {
      it('json_query でJSONデータからパスを取得する', async () => {
        const result = await handleAction({
          action: 'pipeline',
          context: { last_capture: { user: { name: 'Alice' } } },
          steps: [
            {
              type: 'transform',
              op: 'json_query',
              params: { from: 'last_capture', path: 'user.name', export_as: 'user_name' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.user_name).toBe('Alice');
      });

      it('regex_extract でテキストから値を抽出する', async () => {
        const result = await handleAction({
          action: 'pipeline',
          context: { last_capture: 'Status: 200 OK' },
          steps: [
            {
              type: 'transform',
              op: 'regex_extract',
              params: { from: 'last_capture', pattern: 'Status: (\\d+)', export_as: 'status_code' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.status_code).toBe('200');
      });
    });

    describe('apply ops', () => {
      it('write_file でファイルを書き込む', async () => {
        const { safeWriteFile, safeExistsSync } = await import('@agent/core');
        vi.mocked(safeExistsSync).mockReturnValue(true);

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'write_file',
              params: { path: 'output/response.json', content: '{"status": "ok"}' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(safeWriteFile).toHaveBeenCalled();
      });

      it('log オペレーターはメッセージをログに記録する', async () => {
        const { logger } = await import('@agent/core');

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'log',
              params: { message: 'network log test' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
          expect.stringContaining('network log test')
        );
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
    it('任意のstepsに対してstatusは常にsucceeded|failedのいずれか', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              type: fc.constantFrom('apply') as fc.Arbitrary<'apply'>,
              op: fc.constantFrom('log'),
              params: fc.record({ message: fc.string() }),
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

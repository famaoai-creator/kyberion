import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import { handleAction } from './index.js';

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    safeExec: vi.fn().mockReturnValue(''),
    safeExistsSync: vi.fn().mockReturnValue(false),
    safeMkdir: vi.fn(),
    safeReadFile: vi.fn().mockReturnValue('{}'),
    safeWriteFile: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
    derivePipelineStatus: actual.derivePipelineStatus,
    resolveVars: actual.resolveVars,
    evaluateCondition: actual.evaluateCondition,
    pathResolver: {
      rootDir: vi.fn().mockReturnValue('/mock/root'),
      sharedTmp: vi.fn().mockReturnValue('/mock/tmp'),
      resolve: vi.fn((p: string) => `/mock/root/${p}`),
      rootResolve: vi.fn((p: string) => `/mock/root/${p}`),
      knowledge: vi.fn().mockReturnValue('/mock/knowledge'),
    },
  };
});

describe('android-actuator', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset safeExistsSync to return false by default (no artifacts dir)
    const { safeExistsSync } = await import('@agent/core');
    vi.mocked(safeExistsSync).mockReturnValue(false);
  });

  describe('handleAction()', () => {
    it('サポートされていないactionでエラーをスロー', async () => {
      await expect(handleAction({ action: 'invalid' as any, steps: [] })).rejects.toThrow(
        'Unsupported action'
      );
    });

    describe('adb_health_check', () => {
      it('正常系: adb利用可能な場合に adb_available: true を返す', async () => {
        const { safeExec } = await import('@agent/core');
        vi.mocked(safeExec).mockReturnValue('Android Debug Bridge version 1.0.41\n');

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'capture',
              op: 'adb_health_check',
              params: { export_as: 'adb_health' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.adb_available).toBe(true);
      });

      it('エラーケース: adb利用不可な場合に adb_available: false を返す', async () => {
        const { safeExec } = await import('@agent/core');
        vi.mocked(safeExec).mockImplementation(() => {
          throw new Error('adb: command not found');
        });

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'capture',
              op: 'adb_health_check',
              params: { export_as: 'adb_health' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.adb_available).toBe(false);
      });
    });

    describe('launch_app', () => {
      it('エラーケース: adb未利用可能時にエラーをスロー', async () => {
        const { safeExec } = await import('@agent/core');
        vi.mocked(safeExec).mockImplementation(() => {
          throw new Error('adb: command not found');
        });

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'launch_app',
              params: { component: 'com.example/.MainActivity' },
            },
          ],
        });

        expect(result.status).toBe('failed');
        expect(result.results[0].status).toBe('failed');
        expect(result.results[0].error).toContain('adb is not available');
      });
    });

    describe('tap', () => {
      it('エラーケース: 座標を指定して safeExec が正しい引数で呼ばれる', async () => {
        const { safeExec } = await import('@agent/core');
        // First call: adb version (health check), second call: adb devices, third call: actual tap
        vi.mocked(safeExec)
          .mockReturnValueOnce('Android Debug Bridge version 1.0.41\n') // adb version
          .mockReturnValueOnce('List of devices attached\n') // adb devices
          .mockReturnValueOnce(''); // adb shell input tap

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'tap',
              params: { x: 100, y: 200 },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        // Verify safeExec was called with tap command
        const calls = vi.mocked(safeExec).mock.calls;
        const tapCall = calls.find((call) => Array.isArray(call[1]) && call[1].includes('tap'));
        expect(tapCall).toBeDefined();
        expect(tapCall![1]).toContain('100');
        expect(tapCall![1]).toContain('200');
      });
    });

    describe('capture_screen', () => {
      it('エラーケース: スクリーンショット取得後に last_screenshot_path が設定される', async () => {
        const { safeExec } = await import('@agent/core');
        vi.mocked(safeExec)
          .mockReturnValueOnce('Android Debug Bridge version 1.0.41\n') // adb version
          .mockReturnValueOnce('List of devices attached\n') // adb devices
          .mockReturnValueOnce('') // adb shell screencap
          .mockReturnValueOnce('') // adb pull
          .mockReturnValueOnce(''); // adb shell rm (cleanup)

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'capture_screen',
              params: { path: 'output/screen.png' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.last_screenshot_path).toBeDefined();
        expect(typeof result.context.last_screenshot_path).toBe('string');
        expect(result.context.last_screenshot_path).toContain('screen.png');
      });
    });

    describe('open_deep_link', () => {
      it('adb利用可能時にdeep linkを開く', async () => {
        const { safeExec } = await import('@agent/core');
        vi.mocked(safeExec)
          .mockReturnValueOnce('Android Debug Bridge version 1.0.41\n') // adb version
          .mockReturnValueOnce('List of devices attached\n') // adb devices
          .mockReturnValueOnce(''); // adb shell am start

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'open_deep_link',
              params: { url: 'myapp://home' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.last_deep_link_output).toBeDefined();
      });

      it('url未指定時にエラーをスロー', async () => {
        const { safeExec } = await import('@agent/core');
        vi.mocked(safeExec)
          .mockReturnValueOnce('Android Debug Bridge version 1.0.41\n') // adb version
          .mockReturnValueOnce('List of devices attached\n'); // adb devices

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'open_deep_link',
              params: {},
            },
          ],
        });

        expect(result.status).toBe('failed');
        expect(result.results[0].error).toContain('url');
      });
    });

    describe('input_text', () => {
      it('adb利用可能時にテキストを入力する', async () => {
        const { safeExec } = await import('@agent/core');
        vi.mocked(safeExec)
          .mockReturnValueOnce('Android Debug Bridge version 1.0.41\n') // adb version
          .mockReturnValueOnce('List of devices attached\n') // adb devices
          .mockReturnValueOnce(''); // adb shell input text

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'input_text',
              params: { text: 'hello world' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
      });
    });

    describe('swipe', () => {
      it('adb利用可能時にスワイプを実行する', async () => {
        const { safeExec } = await import('@agent/core');
        vi.mocked(safeExec)
          .mockReturnValueOnce('Android Debug Bridge version 1.0.41\n') // adb version
          .mockReturnValueOnce('List of devices attached\n') // adb devices
          .mockReturnValueOnce(''); // adb shell input swipe

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'swipe',
              params: { x1: 100, y1: 500, x2: 100, y2: 200 },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
      });
    });

    describe('log', () => {
      it('logオペレーターはメッセージをログに記録する', async () => {
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
    });

    describe('transform ops', () => {
      it('set オペレーターでコンテキスト変数を設定する', async () => {
        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'transform',
              op: 'set',
              params: { key: 'my_var', value: 'my_value' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.my_var).toBe('my_value');
      });

      it('set オペレーターでkeyが空の場合はコンテキストを変更しない', async () => {
        const result = await handleAction({
          action: 'pipeline',
          context: { existing: 'value' },
          steps: [
            {
              type: 'transform',
              op: 'set',
              params: { key: '', value: 'my_value' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.existing).toBe('value');
      });

      it('未知のtransformオペレーターは警告を出してコンテキストを変更しない', async () => {
        const { logger } = await import('@agent/core');

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'transform',
              op: 'unknown_transform_op',
              params: {},
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(vi.mocked(logger.warn)).toHaveBeenCalled();
      });
    });

    describe('capture ops', () => {
      it('read_text_file でファイルを読み込む', async () => {
        const { safeReadFile } = await import('@agent/core');
        vi.mocked(safeReadFile).mockReturnValueOnce('file content here');

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'capture',
              op: 'read_text_file',
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

      it('未知のcaptureオペレーターは警告を出してコンテキストを変更しない', async () => {
        const { logger } = await import('@agent/core');

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'capture',
              op: 'unknown_capture_op',
              params: {},
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(vi.mocked(logger.warn)).toHaveBeenCalled();
      });
    });

    describe('emit_session_handoff', () => {
      it('target_url未指定時にエラーをスロー', async () => {
        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'emit_session_handoff',
              params: {},
            },
          ],
        });

        expect(result.status).toBe('failed');
        expect(result.results[0].error).toContain('target_url');
      });

      it('target_url指定時にセッションハンドオフを生成する', async () => {
        const { safeWriteFile } = await import('@agent/core');

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'emit_session_handoff',
              params: {
                target_url: 'https://example.com/app',
                path: 'output/handoff.json',
              },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.session_handoff).toBeDefined();
        expect(result.context.session_handoff.target_url).toBe('https://example.com/app');
        expect(safeWriteFile).toHaveBeenCalled();
      });
    });

    describe('tap_ui_node dry_run', () => {
      it('dry_run=trueの場合、adbを呼び出さずにタップターゲットを返す', async () => {
        const xmlWithNode = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="Submit" resource-id="com.example:id/submit" class="android.widget.Button" package="com.example" content-desc="" bounds="[100,200][300,400]" clickable="true" enabled="true" />
</hierarchy>`;

        const result = await handleAction({
          action: 'pipeline',
          context: { last_ui_tree: xmlWithNode },
          steps: [
            {
              type: 'apply',
              op: 'tap_ui_node',
              params: {
                text: 'Submit',
                dry_run: true,
              },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.last_tap_target).toBeDefined();
        expect(result.context.last_tap_target.text).toBe('Submit');
      });
    });

    describe('summarize_ui_tree', () => {
      it('UIツリーXMLを要約する', async () => {
        const xmlWithNodes = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="Hello" resource-id="com.example:id/text1" class="android.widget.TextView" package="com.example" content-desc="" bounds="[0,0][100,50]" clickable="false" enabled="true" />
  <node index="1" text="Click Me" resource-id="com.example:id/btn1" class="android.widget.Button" package="com.example" content-desc="" bounds="[100,100][300,200]" clickable="true" enabled="true" />
</hierarchy>`;

        const result = await handleAction({
          action: 'pipeline',
          context: { last_ui_tree: xmlWithNodes },
          steps: [
            {
              type: 'transform',
              op: 'summarize_ui_tree',
              params: { export_as: 'ui_summary' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.ui_summary).toBeDefined();
        expect(result.context.ui_summary.node_count).toBe(2);
        expect(result.context.ui_summary.clickable_count).toBe(1);
      });
    });

    describe('find_ui_nodes', () => {
      it('テキストでUIノードを検索する', async () => {
        const xmlWithNodes = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="Login" resource-id="com.example:id/login" class="android.widget.Button" package="com.example" content-desc="" bounds="[100,100][300,200]" clickable="true" enabled="true" />
  <node index="1" text="Cancel" resource-id="com.example:id/cancel" class="android.widget.Button" package="com.example" content-desc="" bounds="[100,250][300,350]" clickable="true" enabled="true" />
</hierarchy>`;

        const result = await handleAction({
          action: 'pipeline',
          context: { last_ui_tree: xmlWithNodes },
          steps: [
            {
              type: 'transform',
              op: 'find_ui_nodes',
              params: { text: 'Login', export_as: 'found_nodes' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.found_nodes).toBeDefined();
        expect(result.context.found_nodes.length).toBeGreaterThan(0);
        expect(result.context.found_nodes[0].text).toBe('Login');
      });
    });

    describe('未知のapplyオペレーター', () => {
      it('未知のapplyオペレーターは警告を出してコンテキストを変更しない', async () => {
        const { logger } = await import('@agent/core');

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'unknown_apply_op',
              params: {},
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(vi.mocked(logger.warn)).toHaveBeenCalled();
      });
    });

    describe('未知のstepタイプ', () => {
      it('未知のstepタイプは警告を出してスキップする', async () => {
        const { logger } = await import('@agent/core');

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'unknown_type' as any,
              op: 'some_op',
              params: {},
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(vi.mocked(logger.warn)).toHaveBeenCalled();
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
              type: fc.constantFrom('capture', 'apply', 'transform') as fc.Arbitrary<
                'capture' | 'apply' | 'transform'
              >,
              op: fc.string({ minLength: 1, maxLength: 20 }),
              params: fc.record({ path: fc.string() }),
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
            type: 'transform' as const,
            op: 'set',
            params: { key: `var_${i}`, value: `val_${i}` },
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

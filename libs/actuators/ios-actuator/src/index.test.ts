import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAction } from './index.js';

const MOCK_DEVICES_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
      {
        udid: 'TEST-UDID-1234',
        name: 'iPhone 15',
        state: 'Booted',
        isAvailable: true,
      },
    ],
  },
});

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

describe('ios-actuator', () => {
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

    describe('simctl_health_check', () => {
      it('正常系: simctl利用可能な場合に ios_available: true を返す', async () => {
        const { safeExec } = await import('@agent/core');
        vi.mocked(safeExec)
          .mockReturnValueOnce('xcrun version 64.\n') // xcrun --version
          .mockReturnValueOnce(MOCK_DEVICES_JSON); // xcrun simctl list devices --json

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'capture',
              op: 'simctl_health_check',
              params: { export_as: 'simctl_health' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.ios_available).toBe(true);
      });

      it('エラーケース: simctl利用不可な場合に ios_available: false を返す', async () => {
        const { safeExec } = await import('@agent/core');
        vi.mocked(safeExec).mockImplementation(() => {
          throw new Error('xcrun: error: unable to find utility "simctl"');
        });

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'capture',
              op: 'simctl_health_check',
              params: { export_as: 'simctl_health' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.ios_available).toBe(false);
      });
    });

    describe('launch_app', () => {
      it('エラーケース: bundle_id未指定時にエラーをスロー', async () => {
        const { safeExec } = await import('@agent/core');
        // Health check calls succeed so simctl is "available"
        vi.mocked(safeExec)
          .mockReturnValueOnce('xcrun version 64.\n') // xcrun --version (ensureSimctlAvailable)
          .mockReturnValueOnce(MOCK_DEVICES_JSON); // xcrun simctl list devices --json

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'launch_app',
              params: {
                device_udid: 'TEST-UDID-1234',
                // bundle_id intentionally omitted
              },
            },
          ],
        });

        expect(result.status).toBe('failed');
        expect(result.results[0].status).toBe('failed');
        expect(result.results[0].error).toContain('bundle_id');
      });
    });

    describe('boot_simulator', () => {
      it('正常系: 既にBooted状態の場合にエラーなしで完了する', async () => {
        const { safeExec } = await import('@agent/core');
        vi.mocked(safeExec)
          .mockReturnValueOnce('xcrun version 64.\n') // xcrun --version (ensureSimctlAvailable)
          .mockReturnValueOnce(MOCK_DEVICES_JSON) // xcrun simctl list devices --json
          .mockImplementationOnce(() => {
            // xcrun simctl boot <udid> — already booted error
            throw new Error('Unable to boot device in current state: Booted');
          });

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'boot_simulator',
              params: { device_udid: 'TEST-UDID-1234' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.last_boot_output).toBe('already_booted');
      });
    });

    describe('capture_screen', () => {
      it('正常系: スクリーンショット取得後に last_screenshot_path が設定される', async () => {
        const { safeExec } = await import('@agent/core');
        vi.mocked(safeExec)
          .mockReturnValueOnce('xcrun version 64.\n') // xcrun --version (ensureSimctlAvailable)
          .mockReturnValueOnce(MOCK_DEVICES_JSON) // xcrun simctl list devices --json
          .mockReturnValueOnce(''); // xcrun simctl io <udid> screenshot <path>

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'capture_screen',
              params: {
                device_udid: 'TEST-UDID-1234',
                path: 'output/ios-screen.png',
              },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.last_screenshot_path).toBeDefined();
        expect(typeof result.context.last_screenshot_path).toBe('string');
        expect(result.context.last_screenshot_path).toContain('ios-screen.png');
      });
    });

    describe('open_deep_link', () => {
      it('url未指定時にエラーをスロー', async () => {
        const { safeExec } = await import('@agent/core');
        vi.mocked(safeExec)
          .mockReturnValueOnce('xcrun version 64.\n') // xcrun --version
          .mockReturnValueOnce(MOCK_DEVICES_JSON); // xcrun simctl list devices --json

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'open_deep_link',
              params: { device_udid: 'TEST-UDID-1234' },
            },
          ],
        });

        expect(result.status).toBe('failed');
        expect(result.results[0].error).toContain('url');
      });

      it('url指定時にdeep linkを開く', async () => {
        const { safeExec } = await import('@agent/core');
        vi.mocked(safeExec)
          .mockReturnValueOnce('xcrun version 64.\n') // xcrun --version
          .mockReturnValueOnce(MOCK_DEVICES_JSON) // xcrun simctl list devices --json
          .mockReturnValueOnce(''); // xcrun simctl openurl

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'open_deep_link',
              params: { device_udid: 'TEST-UDID-1234', url: 'myapp://home' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.last_deep_link_output).toBeDefined();
      });
    });

    describe('shutdown_simulator', () => {
      it('シミュレーターをシャットダウンする', async () => {
        const { safeExec } = await import('@agent/core');
        vi.mocked(safeExec)
          .mockReturnValueOnce('xcrun version 64.\n') // xcrun --version
          .mockReturnValueOnce(MOCK_DEVICES_JSON) // xcrun simctl list devices --json
          .mockReturnValueOnce(''); // xcrun simctl shutdown

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'shutdown_simulator',
              params: { device_udid: 'TEST-UDID-1234' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.last_shutdown_output).toBeDefined();
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
              params: { message: 'test ios log message' },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
          expect.stringContaining('test ios log message')
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
        vi.mocked(safeReadFile).mockReturnValueOnce('ios file content');

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
        expect(result.context.file_content).toBe('ios file content');
      });

      it('read_json でJSONファイルを読み込む', async () => {
        const { safeReadFile } = await import('@agent/core');
        vi.mocked(safeReadFile).mockReturnValueOnce(JSON.stringify({ ios_key: 'ios_value' }));

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
        expect(result.context.json_data).toEqual({ ios_key: 'ios_value' });
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
                target_url: 'https://example.com/ios-app',
                path: 'output/ios-handoff.json',
              },
            },
          ],
        });

        expect(result.status).toBe('succeeded');
        expect(result.context.session_handoff).toBeDefined();
        expect(result.context.session_handoff.target_url).toBe('https://example.com/ios-app');
        expect(result.context.session_handoff.source.platform).toBe('ios');
        expect(safeWriteFile).toHaveBeenCalled();
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

    describe('ステップ失敗後の動作', () => {
      it('ステップが失敗した場合、残りのステップを実行しない', async () => {
        const { safeExec } = await import('@agent/core');
        vi.mocked(safeExec).mockImplementation(() => {
          throw new Error('simctl not available');
        });

        const result = await handleAction({
          action: 'pipeline',
          steps: [
            {
              type: 'apply',
              op: 'launch_app',
              params: { device_udid: 'TEST-UDID-1234', bundle_id: 'com.example.app' },
            },
            {
              type: 'apply',
              op: 'capture_screen',
              params: { device_udid: 'TEST-UDID-1234' },
            },
          ],
        });

        expect(result.status).toBe('failed');
        expect(result.results).toHaveLength(1);
        expect(result.results[0].status).toBe('failed');
      });
    });
  });
});

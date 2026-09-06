import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import { handleAction } from './index.js';
import { parseSimctlDevices } from './ios-runtime-helpers.js';

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

const iosTestDoubles = vi.hoisted(() => ({
  assertSafeRepositoryPath: vi.fn((candidate: string) => {
    const value = String(candidate);
    if (value.includes('/../') || value.startsWith('/external')) {
      throw new Error(
        `[RESOURCE_PATH_SCOPE] resource path is outside the repository root: ${value}`
      );
    }
    return value;
  }),
  retry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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
  pathResolver: {
    rootDir: vi.fn().mockReturnValue('/mock/root'),
    shared: vi.fn((p = '') => `/mock/shared/${String(p).replace(/^\/+/, '')}`),
    sharedTmp: vi.fn().mockReturnValue('/mock/tmp'),
    resolve: vi.fn((p: string) => `/mock/root/${p}`),
    rootResolve: vi.fn((p: string) => `/mock/root/${p}`),
    knowledge: vi.fn().mockReturnValue('/mock/knowledge'),
  },
}));

vi.mock('@agent/core/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/core')>()),
  logger: iosTestDoubles.logger,
}));
vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  assertSafeRepositoryPath: iosTestDoubles.assertSafeRepositoryPath,
  safeExec: iosTestDoubles.safeExec,
  safeExistsSync: iosTestDoubles.safeExistsSync,
  safeMkdir: iosTestDoubles.safeMkdir,
  safeReadFile: iosTestDoubles.safeReadFile,
  safeWriteFile: iosTestDoubles.safeWriteFile,
}));
vi.mock('@agent/core/path-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/path-resolver')>()),
  pathResolver: iosTestDoubles.pathResolver,
}));
vi.mock('@agent/core/async-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/async-utils')>()),
  retry: iosTestDoubles.retry,
}));
vi.mock('@agent/core/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/foundation')>()),
  readJson: vi.fn((filePath: string) =>
    JSON.parse(String(iosTestDoubles.safeReadFile(filePath, { encoding: 'utf8' })))
  ),
}));
vi.mock('@agent/core/recovery-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/recovery-policy')>();
  return {
    ...actual,
    createGovernedRetryOptionsBuilder:
      (input: { defaults: Record<string, unknown> }) =>
      (override: Record<string, unknown> = {}) => ({
        ...input.defaults,
        ...override,
        shouldRetry: vi.fn(),
      }),
  };
});

describe('ios-actuator', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset safeExistsSync to return false by default (no artifacts dir)
    const { safeExistsSync } = await import('@agent/core/secure-io');
    vi.mocked(safeExistsSync).mockReturnValue(false);
  });

  it('normalizes simctl device JSON before device selection', () => {
    expect(parseSimctlDevices(MOCK_DEVICES_JSON)).toEqual([
      {
        udid: 'TEST-UDID-1234',
        name: 'iPhone 15',
        state: 'Booted',
        isAvailable: true,
        runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-0',
      },
    ]);
  });

  it('drops malformed simctl roots and device records instead of coercing them', () => {
    expect(parseSimctlDevices(JSON.stringify({ devices: [] }))).toEqual([]);
    expect(
      parseSimctlDevices(
        JSON.stringify({
          devices: {
            runtime: [
              { udid: 123, name: 'iPhone', state: 'Booted' },
              { udid: 'valid', name: 'iPhone', state: 'Booted', isAvailable: 'yes' },
              { udid: 'valid', name: 'iPhone', state: 'Booted', isAvailable: false },
            ],
          },
        })
      )
    ).toEqual([
      { udid: 'valid', name: 'iPhone', state: 'Booted', isAvailable: false, runtime: 'runtime' },
    ]);
  });

  it('rejects dangerous nested keys in simctl output', () => {
    expect(() =>
      parseSimctlDevices(
        JSON.stringify({
          devices: {
            runtime: [{ ['__proto__']: {} }],
          },
        })
      )
    ).toThrow('dangerous JSON key');
  });

  describe('handleAction()', () => {
    it('rejects an artifacts directory outside the repository before device access', async () => {
      await expect(
        handleAction({
          action: 'pipeline',
          options: { artifacts_dir: '../../external-ios-artifacts' },
          steps: [],
        })
      ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
    });

    it('preflightにはplaceholder解決後の実値を渡す', async () => {
      const { registerOpPreflightListener } = await import('@agent/core/op-preflight');
      const seen: unknown[] = [];
      const unregister = registerOpPreflightListener({
        id: 'test:ios-preflight-resolved-params',
        order: -100,
        run: (call, input) => {
          if (call.op === 'ios:set') seen.push(input.value);
        },
      });
      try {
        const result = await handleAction({
          action: 'pipeline',
          context: { source_value: 'resolved-value' },
          steps: [
            {
              type: 'transform',
              op: 'set',
              params: { key: 'observed', value: '{{source_value}}' },
            },
          ],
        });
        expect(seen).toEqual(['resolved-value']);
        expect(result.context.observed).toBe('resolved-value');
      } finally {
        unregister();
      }
    });

    it('サポートされていないactionでエラーをスロー', async () => {
      await expect(handleAction({ action: 'invalid' as any, steps: [] })).rejects.toThrow(
        'Unsupported action'
      );
    });

    describe('simctl_health_check', () => {
      it('正常系: simctl利用可能な場合に ios_available: true を返す', async () => {
        const { safeExec } = await import('@agent/core/secure-io');
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
        expect((await import('@agent/core/async-utils')).retry).toHaveBeenCalled();
      });

      it('エラーケース: simctl利用不可な場合に ios_available: false を返す', async () => {
        const { safeExec } = await import('@agent/core/secure-io');
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
        const { safeExec } = await import('@agent/core/secure-io');
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
        const { safeExec } = await import('@agent/core/secure-io');
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
        const { safeExec } = await import('@agent/core/secure-io');
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
        const { safeExec } = await import('@agent/core/secure-io');
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
        const { safeExec } = await import('@agent/core/secure-io');
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
        const { safeExec } = await import('@agent/core/secure-io');
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
        const { logger } = await import('@agent/core/core');

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

      it('未知のtransformオペレーターはエラーで失敗する(silent no-op 禁止)', async () => {
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

        expect(result.status).toBe('failed');
        expect(result.results[0]?.error).toContain('Unknown op');
      });
    });

    describe('capture ops', () => {
      it('read_text_file でファイルを読み込む', async () => {
        const { safeReadFile } = await import('@agent/core/secure-io');
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
        const { safeReadFile } = await import('@agent/core/secure-io');
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

      it('未知のcaptureオペレーターはエラーで失敗する(silent no-op 禁止)', async () => {
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

        expect(result.status).toBe('failed');
        expect(result.results[0]?.error).toContain('Unknown op');
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
        const { safeWriteFile } = await import('@agent/core/secure-io');

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
      it('未知のapplyオペレーターはエラーで失敗する(silent no-op 禁止)', async () => {
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

        expect(result.status).toBe('failed');
        expect(result.results[0]?.error).toContain('Unknown op');
      });
    });

    describe('未知のstepタイプ', () => {
      it('未知のstepタイプは警告を出してスキップする', async () => {
        const { logger } = await import('@agent/core/core');

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
        const { safeExec } = await import('@agent/core/secure-io');
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

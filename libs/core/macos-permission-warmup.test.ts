import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  ensureMacOSSwiftBinary: vi.fn(),
  resolveMacOSHostApp: vi.fn(),
  runMacOSNativeBinary: vi.fn(),
}));
vi.mock('./macos-native-automation.js', () => native);

import {
  DEFAULT_PERMISSION_WARMUP_KINDS,
  PERMISSION_SETTINGS_PANE,
  warmupMacOSPermissions,
} from './macos-permission-warmup.js';

const originalPlatform = process.platform;
function platform(value: string) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('macOS permission warm-up', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    platform('darwin');
    native.ensureMacOSSwiftBinary.mockReturnValue('/cache/warmup-bin');
    native.resolveMacOSHostApp.mockReturnValue('com.apple.Terminal');
  });
  afterEach(() => platform(originalPlatform));

  it('is unsupported off macOS and never runs anything', () => {
    platform('linux');
    expect(warmupMacOSPermissions()).toMatchObject({ supported: false, results: {} });
    expect(native.ensureMacOSSwiftBinary).not.toHaveBeenCalled();
  });

  it('requests only the microphone by default', () => {
    native.runMacOSNativeBinary.mockReturnValue({
      microphone: { before: 'not_determined', after: 'granted' },
    });
    const result = warmupMacOSPermissions();
    expect(DEFAULT_PERMISSION_WARMUP_KINDS).toEqual(['microphone']);
    expect(native.runMacOSNativeBinary).toHaveBeenCalledWith(
      '/cache/warmup-bin',
      [JSON.stringify({ kinds: ['microphone'] })],
      expect.any(Number)
    );
    expect(result).toEqual({
      supported: true,
      host_app: 'com.apple.Terminal',
      results: { microphone: { before: 'not_determined', after: 'granted' } },
    });
  });

  it('returns the settings pane for denied kinds without opening anything', () => {
    native.runMacOSNativeBinary.mockReturnValue({
      microphone: { before: 'denied', after: 'denied' },
      camera: { before: 'granted', after: 'granted' },
      screen_recording: { before: 'denied', after: 'denied' },
    });
    const { results } = warmupMacOSPermissions(['microphone', 'camera', 'screen_recording']);
    expect(results.microphone?.remedy).toBe(PERMISSION_SETTINGS_PANE.microphone);
    expect(results.camera?.remedy).toBeUndefined();
    expect(results.screen_recording?.remedy).toContain('Privacy_ScreenCapture');
  });

  it('points screen recording at System Settings when it stays ungranted after a request', () => {
    native.runMacOSNativeBinary.mockReturnValue({
      screen_recording: { before: 'unknown', after: 'unknown' },
    });
    const { results } = warmupMacOSPermissions(['screen_recording']);
    expect(results.screen_recording?.remedy).toBe(PERMISSION_SETTINGS_PANE.screen_recording);
  });

  it('keeps other kinds when one helper run fails', () => {
    native.runMacOSNativeBinary.mockImplementation((_bin: string, args: string[]) => {
      if (args[0].includes('camera')) throw new Error('native_execution_failed');
      return { microphone: { before: 'granted', after: 'granted' } };
    });
    const { results } = warmupMacOSPermissions(['microphone', 'camera']);
    expect(native.runMacOSNativeBinary).toHaveBeenCalledTimes(2);
    expect(results.microphone).toEqual({ before: 'granted', after: 'granted' });
    expect(results.camera).toEqual({
      before: 'unknown',
      after: 'unknown',
      error: 'native_execution_failed',
    });
  });

  it('refuses to request anything when no terminal host app is identified', () => {
    expect(warmupMacOSPermissions(['microphone'], '')).toEqual({
      supported: true,
      results: {},
      reason: 'host_app_unknown',
    });
    expect(native.ensureMacOSSwiftBinary).not.toHaveBeenCalled();
    expect(native.runMacOSNativeBinary).not.toHaveBeenCalled();
  });

  it('gives no settings remedy for a policy-restricted permission', () => {
    native.runMacOSNativeBinary.mockReturnValue({
      microphone: { before: 'restricted', after: 'restricted' },
    });
    const { results } = warmupMacOSPermissions(['microphone']);
    expect(results.microphone).toEqual({ before: 'restricted', after: 'restricted' });
  });
});

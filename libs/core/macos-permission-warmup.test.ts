import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  ensureMacOSSwiftBinary: vi.fn(),
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

  it('reports a failed helper instead of throwing', () => {
    native.runMacOSNativeBinary.mockImplementation(() => {
      throw new Error('native_execution_failed');
    });
    expect(warmupMacOSPermissions()).toEqual({
      supported: true,
      results: {},
      reason: 'native_execution_failed',
    });
  });
});

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { preferencesReadiness } = vi.hoisted(() => ({
  preferencesReadiness: vi.fn(
    (): ReturnType<
      typeof import('../voice/engine-runtime-preferences.js').engineRuntimePreferencesReadiness
    > => ({ status: 'missing' })
  ),
}));
vi.mock('../voice/engine-runtime-preferences.js', () => ({
  engineRuntimePreferencesReadiness: preferencesReadiness,
}));
import {
  resolveAdbBin,
  resolveExternalToolBin,
  resolveFfmpegBin,
  resolveFfprobeBin,
  resolveLightpandaBin,
  resolvePython3Bin,
  resolveRustxngBin,
  resolveSpeechCppBin,
  resolveTailscaleBin,
  resolveXcodebuildBin,
  resolveXcrunBin,
} from './tool-binary-resolvers.js';

describe('tool binary resolvers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers a registered environment override over the runtime registry', () => {
    vi.stubEnv('KYBERION_FFMPEG_BIN', '/opt/kyberion/bin/ffmpeg-custom');
    expect(resolveFfmpegBin()).toBe('/opt/kyberion/bin/ffmpeg-custom');
  });

  it('uses the governed registry command when no override is configured', () => {
    for (const name of [
      'KYBERION_FFMPEG_BIN',
      'KYBERION_FFPROBE_BIN',
      'KYBERION_ADB_BIN',
      'KYBERION_XCRUN_BIN',
      'KYBERION_XCODEBUILD_BIN',
      'ANDROID_HOME',
      'ANDROID_SDK_ROOT',
    ]) {
      vi.stubEnv(name, '');
    }
    expect(resolveFfmpegBin()).toBe('ffmpeg');
    expect(resolveFfprobeBin()).toBe('ffprobe');
    expect(resolveXcrunBin()).toBe('xcrun');
    expect(resolveXcodebuildBin()).toBe('xcodebuild');
    expect(resolveAdbBin()).toBe('adb');
  });

  it('supports both Python override names with the current name first', () => {
    vi.stubEnv('KYBERION_PYTHON', '/opt/legacy/python');
    expect(resolvePython3Bin()).toBe('/opt/legacy/python');

    vi.stubEnv('KYBERION_PYTHON_BIN', '/opt/current/python');
    expect(resolvePython3Bin()).toBe('/opt/current/python');
  });

  it('resolves Lightpanda through its env override, then the registry command', () => {
    vi.stubEnv('KYBERION_LIGHTPANDA_BIN', '/opt/kyberion/bin/lightpanda');
    expect(resolveLightpandaBin()).toBe('/opt/kyberion/bin/lightpanda');
    vi.stubEnv('KYBERION_LIGHTPANDA_BIN', '');
    expect(resolveLightpandaBin()).toMatch(/lightpanda$/);
  });

  it('resolves RustXNG through its env override, then the registry command', () => {
    vi.stubEnv('KYBERION_RUSTXNG_BIN', '/opt/kyberion/bin/rustxng');
    expect(resolveRustxngBin()).toBe('/opt/kyberion/bin/rustxng');
    vi.stubEnv('KYBERION_RUSTXNG_BIN', '');
    expect(resolveRustxngBin()).toMatch(/rustxng$/);
  });

  it('resolves speech.cpp through its env override, then the registry command', () => {
    vi.stubEnv('KYBERION_SPEECH_CPP_BIN', '/opt/kyberion/bin/speech');
    expect(resolveSpeechCppBin()).toBe('/opt/kyberion/bin/speech');
    vi.stubEnv('KYBERION_SPEECH_CPP_BIN', '');
    expect(resolveSpeechCppBin()).toMatch(/speech$/);
  });

  it('finds the Tailscale CLI on macOS without Install CLI, env override first', () => {
    vi.stubEnv('KYBERION_TAILSCALE_BIN', '');
    const bundle = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    expect(
      resolveTailscaleBin({ platform: 'darwin', exists: (candidate) => candidate === bundle })
    ).toBe(bundle);
    expect(
      resolveTailscaleBin({
        platform: 'darwin',
        exists: (candidate) => candidate === bundle || candidate === '/usr/local/bin/tailscale',
      })
    ).toBe('/usr/local/bin/tailscale');
    expect(resolveTailscaleBin({ platform: 'linux', exists: () => true })).toMatch(/tailscale$/);
    expect(resolveTailscaleBin({ platform: 'darwin', exists: () => false })).toMatch(/tailscale$/);
    vi.stubEnv('KYBERION_TAILSCALE_BIN', '/opt/custom/tailscale');
    expect(resolveTailscaleBin({ platform: 'darwin', exists: () => true })).toBe(
      '/opt/custom/tailscale'
    );
  });

  it('falls back to the literal only when the registry record is unavailable', () => {
    expect(resolveExternalToolBin('unknown-tool', [], 'unknown-tool')).toBe('unknown-tool');
  });
});

beforeEach(() => {
  preferencesReadiness.mockReset();
  preferencesReadiness.mockReturnValue({ status: 'missing' });
});

describe('engine binary defaults', () => {
  it('trims saved paths and falls back only for optional absence', () => {
    preferencesReadiness.mockReturnValue({
      status: 'ready',
      preferences: { version: '1.0.0', ffmpeg_bin: '  /opt/tools/ffmpeg  ' },
    });
    expect(resolveExternalToolBin('unknown-tool', [], 'fallback', 'ffmpeg_bin')).toBe(
      '/opt/tools/ffmpeg'
    );
    preferencesReadiness.mockReturnValue({
      status: 'unavailable',
      reason: 'personal_profile_not_authorized',
    });
    expect(resolveExternalToolBin('unknown-tool', [], 'fallback', 'ffmpeg_bin')).toBe('fallback');
  });
  it('propagates profile failures but never reads below an explicit environment override', () => {
    preferencesReadiness.mockImplementation(() => {
      throw new Error('profile denied');
    });
    vi.stubEnv('KYBERION_FFMPEG_BIN', '/explicit/ffmpeg');
    expect(resolveFfmpegBin()).toBe('/explicit/ffmpeg');
    expect(preferencesReadiness).not.toHaveBeenCalled();
    vi.stubEnv('KYBERION_FFMPEG_BIN', '');
    expect(() => resolveFfmpegBin()).toThrow('profile denied');
  });
});

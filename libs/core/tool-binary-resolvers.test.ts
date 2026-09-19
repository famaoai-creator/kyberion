import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveAdbBin,
  resolveExternalToolBin,
  resolveFfmpegBin,
  resolveFfprobeBin,
  resolvePython3Bin,
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

  it('falls back to the literal only when the registry record is unavailable', () => {
    expect(resolveExternalToolBin('unknown-tool', [], 'unknown-tool')).toBe('unknown-tool');
  });
});

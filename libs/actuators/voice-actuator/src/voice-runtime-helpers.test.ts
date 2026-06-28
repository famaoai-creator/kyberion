import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(() => ''),
  safeExistsSync: vi.fn((target: string) => String(target).includes('espeak-ng') || String(target).endsWith('.aiff') || String(target).endsWith('.wav')),
  safeStat: vi.fn(() => ({ size: 4096 })),
  safeMkdir: vi.fn(),
  safeExecResult: vi.fn(() => ({
    status: 0,
    stdout: '{"status":"success","output_path":"/tmp/espeak-ng-fallback.wav"}',
    stderr: '',
    error: null,
  })),
  safeReadFile: vi.fn(() => '{"recovery_policy": {}}'),
  getVoiceEngineRecord: vi.fn((engineId?: string) => {
    if (engineId === 'espeak_ng') {
      return {
        engine_id: 'espeak_ng',
        display_name: 'espeak-ng TTS',
        kind: 'native_local',
        provider: 'espeak_ng',
        status: 'active',
        platforms: ['darwin', 'linux', 'win32'],
        bridge_script: 'libs/actuators/voice-actuator/scripts/espeak_ng_tts_bridge.py',
        supports: {
          list_voices: true,
          playback: true,
          artifact_formats: ['wav', 'aiff'],
        },
      };
    }
    return {
      engine_id: 'local_say',
      display_name: 'Local System TTS',
      kind: 'native_local',
      provider: 'system_tts',
      status: 'active',
      platforms: ['darwin', 'linux', 'win32'],
      supports: {
        list_voices: true,
        playback: true,
        artifact_formats: ['wav', 'aiff'],
      },
      fallback_engine_id: 'espeak_ng',
    };
  }),
  getVoiceEngineRegistry: vi.fn(() => ({
    version: 'test',
    default_engine_id: 'local_say',
    engines: [
      {
        engine_id: 'local_say',
        display_name: 'Local System TTS',
        kind: 'native_local',
        provider: 'system_tts',
        status: 'active',
        platforms: ['darwin', 'linux', 'win32'],
        supports: {
          list_voices: true,
          playback: true,
          artifact_formats: ['wav', 'aiff'],
        },
        fallback_engine_id: 'espeak_ng',
      },
      {
        engine_id: 'espeak_ng',
        display_name: 'espeak-ng TTS',
        kind: 'native_local',
        provider: 'espeak_ng',
        status: 'active',
        platforms: ['darwin', 'linux', 'win32'],
        bridge_script: 'libs/actuators/voice-actuator/scripts/espeak_ng_tts_bridge.py',
        supports: {
          list_voices: true,
          playback: true,
          artifact_formats: ['wav', 'aiff'],
        },
      },
    ],
  })),
  getVoiceTtsLanguageConfig: vi.fn(() => ({
    voice: 'Kyoko',
    rate: 170,
  })),
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual('@agent/core') as any;
  return {
    ...actual,
    getVoiceEngineRecord: mocks.getVoiceEngineRecord,
    getVoiceTtsLanguageConfig: mocks.getVoiceTtsLanguageConfig,
    logger: mocks.logger,
    safeExec: mocks.safeExec,
    safeExistsSync: mocks.safeExistsSync,
    safeMkdir: mocks.safeMkdir,
    safeExecResult: mocks.safeExecResult,
    safeReadFile: mocks.safeReadFile,
    safeStat: mocks.safeStat,
    getVoiceEngineRegistry: mocks.getVoiceEngineRegistry,
    withRetry: mocks.withRetry,
  };
});

describe('voice runtime helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let probeCalls = 0;
    mocks.safeExec.mockImplementation((command: string) => {
      if (command === 'say') {
        return '';
      }
      if (command === 'espeak-ng') {
        return '';
      }
      if (command === 'ffmpeg') {
        return '';
      }
      if (command === 'ffprobe') {
        probeCalls += 1;
        return probeCalls === 1 ? '' : '10.5';
      }
      return '';
    });
  });

  it('falls back to a configured engine when say produces a zero-length artifact', async () => {
    const { renderNativeArtifact } = await import('./voice-runtime-helpers.js');

    const outputPath = '/tmp/kyberion-fallback-narration.aiff';
    const artifactPath = await renderNativeArtifact('Kyberion は運用の意図を成果物に変えます。', {
      requestId: 'fallback-test',
      voice: 'Kyoko',
      rate: 170,
      language: 'ja',
      format: 'aiff',
      engineId: 'local_say',
      supportsFormats: ['wav', 'aiff'],
      outputPath,
    });

    expect(artifactPath).toBe(outputPath);
    expect(mocks.safeExec.mock.calls.some(([command]) => command === 'say')).toBe(true);
    expect(mocks.safeExecResult).toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('configured engine local_say failed'));
  });
});

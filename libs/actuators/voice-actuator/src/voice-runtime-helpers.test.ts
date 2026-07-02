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
    if (engineId === 'mlx_audio_qwen3') {
      return {
        engine_id: 'mlx_audio_qwen3',
        display_name: 'mlx-audio Qwen3-TTS (ICL Voice Clone)',
        kind: 'voice_clone_service',
        provider: 'mlx_audio',
        status: 'active',
        platforms: ['darwin'],
        bridge_script: 'libs/actuators/voice-actuator/scripts/mlx_audio_tts_bridge.py',
        supports: {
          list_voices: false,
          playback: true,
          artifact_formats: ['wav'],
          voice_clone: true,
          icl_ref_audio: true,
        },
        fallback_engine_id: 'local_say',
      };
    }
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
        engine_id: 'mlx_audio_qwen3',
        display_name: 'mlx-audio Qwen3-TTS (ICL Voice Clone)',
        kind: 'voice_clone_service',
        provider: 'mlx_audio',
        status: 'active',
        platforms: ['darwin'],
        bridge_script: 'libs/actuators/voice-actuator/scripts/mlx_audio_tts_bridge.py',
        supports: {
          list_voices: false,
          playback: true,
          artifact_formats: ['wav'],
          voice_clone: true,
          icl_ref_audio: true,
        },
        fallback_engine_id: 'local_say',
      },
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
  resolveManagedToolPythonBin: vi.fn(() => null),
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
    resolveManagedToolPythonBin: mocks.resolveManagedToolPythonBin,
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

  it('does not fall back to non-clone engines when learned voice is required', async () => {
    const { renderNativeArtifact } = await import('./voice-runtime-helpers.js');

    mocks.safeExecResult.mockReturnValueOnce({
      status: 1,
      stdout: '',
      stderr: 'mlx failed',
      error: null,
    });

    await expect(renderNativeArtifact('学習済み音声だけを使います。', {
      requestId: 'strict-clone-test',
      voice: 'Kyoko',
      rate: 170,
      language: 'ja',
      format: 'wav',
      engineId: 'mlx_audio_qwen3',
      supportsFormats: ['wav'],
      outputPath: '/tmp/strict-clone-test.wav',
      requireVoiceClone: true,
      profile: {
        profile_id: 'my-voice-v2',
        sample_refs: ['/tmp/ref.wav'],
      },
    })).rejects.toThrow('mlx_audio_tts_bridge.py failed');

    expect(mocks.safeExec).not.toHaveBeenCalledWith(
      'say',
      expect.arrayContaining(['学習済み音声だけを使います。']),
    );
  });
});

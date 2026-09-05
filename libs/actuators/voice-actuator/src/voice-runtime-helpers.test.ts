import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(() => ''),
  safeExistsSync: vi.fn(
    (target: string) =>
      String(target).includes('espeak-ng') ||
      String(target).endsWith('.py') ||
      String(target).endsWith('.aiff') ||
      String(target).endsWith('.wav')
  ),
  safeLstat: vi.fn(() => ({ isFile: () => true })),
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
  retry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  resolveManagedToolPythonBin: vi.fn(() => null),
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// Keep the doubles on the canonical module boundaries used by the runtime
// helper. The production secure-io guard must not see the test's /tmp paths.
vi.mock('@agent/core/secure-io', () => ({
  assertSafeRepositoryPath: (candidate: string) => {
    const value = String(candidate);
    if (value.startsWith('/var/') || value.includes('../')) {
      throw new Error(
        `[RESOURCE_PATH_SCOPE] resource path is outside the repository root: ${value}`
      );
    }
    return value;
  },
  safeExec: mocks.safeExec,
  safeExecResult: mocks.safeExecResult,
  safeExistsSync: mocks.safeExistsSync,
  safeMkdir: mocks.safeMkdir,
  safeReadFile: mocks.safeReadFile,
  safeLstat: mocks.safeLstat,
  safeStat: mocks.safeStat,
}));
vi.mock('@agent/core/path-resolver', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/path-resolver')>(
    '@agent/core/path-resolver'
  );
  return {
    ...actual,
    pathResolver: {
      ...actual.pathResolver,
      rootResolve: vi.fn((value: string) => value),
      sharedTmp: vi.fn((value: string) => `/tmp/${value}`),
    },
  };
});
vi.mock('@agent/core/voice-engine-registry', () => ({
  getVoiceEngineRecord: mocks.getVoiceEngineRecord,
  getVoiceEngineRegistry: mocks.getVoiceEngineRegistry,
  resolveVoiceEngineForPlatform: mocks.getVoiceEngineRecord,
}));
vi.mock('@agent/core/voice-tts-config', () => ({
  getVoiceTtsLanguageConfig: mocks.getVoiceTtsLanguageConfig,
}));
vi.mock('@agent/core/async-utils', () => ({ retry: mocks.retry }));
vi.mock('@agent/core/tool-runtime-registry', () => ({
  resolveManagedToolPythonBin: mocks.resolveManagedToolPythonBin,
}));
vi.mock('@agent/core/core', () => ({ logger: mocks.logger }));

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

  it('accepts a successful local STT response', async () => {
    const { parseVoiceSttBridgeResponse } = await import('./voice-runtime-helpers.js');
    expect(
      parseVoiceSttBridgeResponse({ status: 'success', text: 'hello', language: 'en' })
    ).toEqual({ status: 'success', text: 'hello', language: 'en' });
  });

  it('preserves validated capabilities and transcript segments', async () => {
    const { parseVoiceSttBridgeResponse } = await import('./voice-runtime-helpers.js');
    expect(
      parseVoiceSttBridgeResponse({
        status: 'success',
        text: 'hello',
        capabilities: { timestamps: true, granularity: 'segment' },
        segments: [{ start_sec: 0, end_sec: 1, text: 'hello' }],
      })
    ).toMatchObject({
      capabilities: { timestamps: true, granularity: 'segment' },
      segments: [{ start_sec: 0, end_sec: 1, text: 'hello' }],
    });
  });

  it('rejects a successful response without transcript text', async () => {
    const { parseVoiceSttBridgeResponse } = await import('./voice-runtime-helpers.js');
    expect(parseVoiceSttBridgeResponse({ status: 'success' })).toBeUndefined();
    expect(parseVoiceSttBridgeResponse({ status: 'success', text: 123 })).toBeUndefined();
  });

  it('rejects primitive and malformed capability responses', async () => {
    const { parseVoiceSttBridgeResponse } = await import('./voice-runtime-helpers.js');
    expect(parseVoiceSttBridgeResponse([])).toBeUndefined();
    expect(
      parseVoiceSttBridgeResponse({
        status: 'success',
        text: 'hello',
        capabilities: { timestamps: true, granularity: 'invalid' },
      })
    ).toBeUndefined();
  });

  it('rejects voice profile and artifact paths outside the repository', async () => {
    const { resolveArtifactPath, resolveProfileRefAudio } =
      await import('./voice-runtime-helpers.js');
    expect(() => resolveArtifactPath('boundary', 'wav', '/var/external-voice.wav')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
    expect(() => resolveProfileRefAudio({ sample_refs: ['/var/external-reference.wav'] })).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
  });

  it('rejects a non-regular voice reference before bridge execution', async () => {
    const { resolveProfileRefAudio } = await import('./voice-runtime-helpers.js');
    mocks.safeLstat.mockReturnValueOnce({ isFile: () => false });

    expect(() => resolveProfileRefAudio({ sample_refs: ['/tmp/reference.wav'] })).toThrow(
      'existing regular file'
    );
  });

  // darwin-only: exercises the macOS say → espeak fallback chain; the engine
  // records themselves declare mlx/say as darwin platforms.
  it.skipIf(process.platform !== 'darwin')(
    'falls back to a configured engine when say produces a zero-length artifact',
    async () => {
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
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('configured engine local_say failed')
      );
    }
  );

  it.skipIf(process.platform !== 'darwin')(
    'does not fall back to non-clone engines when learned voice is required',
    async () => {
      const { renderNativeArtifact } = await import('./voice-runtime-helpers.js');

      mocks.safeExecResult.mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'mlx failed',
        error: null,
      });

      await expect(
        renderNativeArtifact('学習済み音声だけを使います。', {
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
        })
      ).rejects.toThrow('mlx_audio_tts_bridge.py failed');

      expect(mocks.safeExec).not.toHaveBeenCalledWith(
        'say',
        expect.arrayContaining(['学習済み音声だけを使います。'])
      );
    }
  );

  it.skipIf(process.platform !== 'darwin')(
    'accepts a successful TTS payload after bridge progress logs',
    async () => {
      const { renderNativeArtifact } = await import('./voice-runtime-helpers.js');

      mocks.safeExecResult.mockReturnValueOnce({
        status: 0,
        stdout:
          'Initialized encoder codebooks\n{"status":"success","output_path":"/tmp/logged-tts.wav"}\n',
        stderr: '',
        error: null,
      });
      mocks.safeExec.mockImplementation((command: string) => {
        if (command === 'ffprobe') return '2.0';
        return '';
      });

      await expect(
        renderNativeArtifact('ログ付きでも再生できます。', {
          requestId: 'logged-tts-test',
          voice: 'Kyoko',
          rate: 170,
          language: 'ja',
          format: 'wav',
          engineId: 'mlx_audio_qwen3',
          supportsFormats: ['wav'],
          outputPath: '/tmp/logged-tts.wav',
          requireVoiceClone: true,
        })
      ).resolves.toBe('/tmp/logged-tts.wav');
    }
  );
});

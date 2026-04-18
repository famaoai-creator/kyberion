import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  compileSchemaFromPath: vi.fn(() => {
    const validator: any = () => true;
    validator.errors = [];
    return validator;
  }),
  getVoiceProfileRecord: vi.fn(() => ({
    profile_id: 'operator-ja-default',
    display_name: 'Operator Japanese Default',
    tier: 'public',
    languages: ['ja'],
    default_engine_id: 'local_say',
    status: 'active',
  })),
  getVoiceRuntimePolicy: vi.fn(() => ({
    version: 'test',
    queue: { concurrency: 1, cancellation: 'queued_or_running' },
    chunking: {
      default_max_chunk_chars: 20,
      default_crossfade_ms: 50,
      preserve_paralinguistic_tags: true,
    },
    progress: {
      throttle_ms: 0,
      min_percent_delta: 0,
      emit_heartbeat: true,
    },
    delivery: {
      default_format: 'wav',
      retain_original_version: true,
      create_processed_version: false,
    },
  })),
  getVoiceEngineRecord: vi.fn(() => ({
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
  })),
  resolveVoiceEngineForPlatform: vi.fn(() => ({
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
  })),
  getVoiceTtsLanguageConfig: vi.fn(() => ({
    voice: 'Kyoko',
    rate: 180,
  })),
  safeExec: vi.fn(() => ''),
  safeMkdir: vi.fn(),
  safeWriteFile: vi.fn(),
  safeReadFile: vi.fn(),
  getVoiceSampleIngestionPolicy: vi.fn(() => ({
    version: 'test',
    sample_limits: {
      min_samples: 3,
      max_samples: 20,
      min_sample_bytes: 4096,
      max_sample_bytes: 26214400,
      allowed_extensions: ['wav', 'aiff'],
    },
    profile_rules: {
      allowed_tiers: ['personal', 'confidential'],
      require_unique_sample_paths: true,
      require_language_coverage: true,
      strict_personal_voice_registration: true,
    },
  })),
  validateVoiceProfileRegistration: vi.fn(() => ({
    ok: true,
    violations: [],
    summary: {
      sample_count: 3,
      total_sample_bytes: 12345,
      strict_personal_voice: true,
    },
  })),
  splitVoiceTextIntoChunks: vi.fn((text: string) => [text.slice(0, 5), text.slice(5)]),
  randomUUID: vi.fn(() => 'job-123'),
}));

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual('@agent/core') as any;
  return {
    ...actual,
    compileSchemaFromPath: mocks.compileSchemaFromPath,
    getVoiceProfileRecord: mocks.getVoiceProfileRecord,
    getVoiceRuntimePolicy: mocks.getVoiceRuntimePolicy,
    getVoiceEngineRecord: mocks.getVoiceEngineRecord,
    resolveVoiceEngineForPlatform: mocks.resolveVoiceEngineForPlatform,
    getVoiceTtsLanguageConfig: mocks.getVoiceTtsLanguageConfig,
    safeExec: mocks.safeExec,
    safeMkdir: mocks.safeMkdir,
    safeWriteFile: mocks.safeWriteFile,
    safeReadFile: mocks.safeReadFile,
    getVoiceSampleIngestionPolicy: mocks.getVoiceSampleIngestionPolicy,
    validateVoiceProfileRegistration: mocks.validateVoiceProfileRegistration,
    splitVoiceTextIntoChunks: mocks.splitVoiceTextIntoChunks,
    pathResolver: {
      ...actual.pathResolver,
      sharedTmp: vi.fn((value: string) => `/tmp/${value}`),
    },
  };
});

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: mocks.randomUUID,
  };
});

describe('voice actuator', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('uses native speak defaults for speak_local', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      action: 'speak_local',
      params: { text: 'hello world', language: 'ja' },
    } as any);

    expect(result).toEqual(expect.objectContaining({
      status: 'succeeded',
      language: 'ja',
      voice: 'Kyoko',
      rate: 180,
      resolved_engine_id: 'local_say',
    }));
    expect(mocks.safeExec).toHaveBeenCalledWith('say', ['-v', 'Kyoko', '-r', '180', 'hello world']);
  });

  it('runs generate_voice through native artifact and playback flow', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      action: 'generate_voice',
      request_id: 'req-1',
      text: 'hello world',
      profile_ref: { profile_id: 'operator-ja-default' },
      engine: { engine_id: 'local_say' },
      rendering: {
        language: 'ja',
        chunking: {
          max_chunk_chars: 20,
          crossfade_ms: 50,
          preserve_paralinguistic_tags: true,
        },
      },
      delivery: {
        mode: 'artifact_and_playback',
        format: 'wav',
        emit_progress_packets: true,
      },
    } as any);

    expect(result).toEqual(expect.objectContaining({
      status: 'succeeded',
      request_id: 'req-1',
      engine_id: 'local_say',
      resolved_engine_id: 'local_say',
      chunks: 2,
      delivery_mode: 'artifact_and_playback',
    }));
    expect(result.artifact_refs).toEqual(['/tmp/voice-generation/req-1.aiff']);
    expect(result.progress_packets.length).toBeGreaterThan(0);
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'say',
      ['-v', 'Kyoko', '-r', '180', '-o', '/tmp/voice-generation/req-1.aiff', 'hello world'],
    );
  });

  it('blocks profile registration when validation fails', async () => {
    mocks.validateVoiceProfileRegistration.mockReturnValueOnce({
      ok: false,
      violations: ['missing sample language coverage for ja'],
      summary: {
        sample_count: 1,
        total_sample_bytes: 2048,
        strict_personal_voice: true,
      },
    });
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'register_voice_profile',
      request_id: 'reg-1',
      profile: {
        profile_id: 'user-ja-voice',
        display_name: 'User JA',
        tier: 'personal',
        languages: ['ja'],
        default_engine_id: 'open_voice_clone',
      },
      samples: [{ sample_id: 's1', path: 'active/shared/tmp/sample.wav', language: 'en' }],
    } as any);

    expect(result).toEqual(expect.objectContaining({
      status: 'blocked',
      action: 'register_voice_profile',
      request_id: 'reg-1',
      violations: ['missing sample language coverage for ja'],
    }));
    expect(mocks.safeWriteFile).not.toHaveBeenCalled();
  });

  it('creates registration receipt when validation succeeds', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'register_voice_profile',
      request_id: 'reg-2',
      profile: {
        profile_id: 'user-ja-voice',
        display_name: 'User JA',
        tier: 'personal',
        languages: ['ja'],
        default_engine_id: 'open_voice_clone',
      },
      samples: [
        { sample_id: 's1', path: 'active/shared/tmp/sample-1.wav', language: 'ja' },
        { sample_id: 's2', path: 'active/shared/tmp/sample-2.wav', language: 'ja' },
        { sample_id: 's3', path: 'active/shared/tmp/sample-3.wav', language: 'ja' },
      ],
    } as any);

    expect(result).toEqual(expect.objectContaining({
      status: 'succeeded',
      action: 'register_voice_profile',
      request_id: 'reg-2',
      registration_receipt_path: '/tmp/voice-profile-registration/reg-2.json',
    }));
    expect(mocks.safeMkdir).toHaveBeenCalledWith('/tmp/voice-profile-registration', { recursive: true });
    expect(mocks.safeWriteFile).toHaveBeenCalled();
  });
});

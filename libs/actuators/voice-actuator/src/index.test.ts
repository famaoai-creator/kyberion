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
    routing: {
      default_personal_voice_mode: 'allow_fallback',
      enforce_clone_engine_for_personal_tier: true,
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
  withRetry: vi.fn(async (fn: () => Promise<any>) => fn()),
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
  collectVoiceSamples: vi.fn((input: any) => ({
    status: 'succeeded',
    action: 'collect_voice_samples',
    request_id: input.request_id,
    collection_manifest_path: `/tmp/voice-sample-collection/${input.request_id}/collection-manifest.json`,
    collection_dir: `/tmp/voice-sample-collection/${input.request_id}`,
    staged_samples: (input.samples || []).map((sample: any) => ({
      ...sample,
      staged_path: `/tmp/voice-sample-collection/${input.request_id}/${sample.sample_id}.wav`,
      bytes: 12345,
      extension: 'wav',
    })),
    summary: {
      sample_count: (input.samples || []).length,
      total_sample_bytes: 12345 * (input.samples || []).length,
      collection_dir: `/tmp/voice-sample-collection/${input.request_id}`,
    },
    registration_candidate: {
      action: 'register_voice_profile',
      request_id: input.request_id,
      profile: input.profile_draft,
      samples: (input.samples || []).map((sample: any) => ({
        sample_id: sample.sample_id,
        path: `/tmp/voice-sample-collection/${input.request_id}/${sample.sample_id}.wav`,
        language: sample.language,
      })),
    },
  })),
  recordVoiceSample: vi.fn((input: any) => ({
    status: 'succeeded',
    action: 'record_voice_sample',
    request_id: input.request_id,
    sample_id: input.sample_id,
    output_path: `/tmp/voice-sample-recording/${input.request_id}/${input.sample_id}.wav`,
    prompt_path: `/tmp/voice-sample-recording/${input.request_id}/${input.sample_id}.prompt.txt`,
    duration_sec: input.duration_sec,
    backend: 'shell-command',
  })),
  randomUUID: vi.fn(() => 'job-123'),
}));

vi.mock('@agent/core', async () => {
  return {
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
    withRetry: mocks.withRetry,
    getVoiceSampleIngestionPolicy: mocks.getVoiceSampleIngestionPolicy,
    validateVoiceProfileRegistration: mocks.validateVoiceProfileRegistration,
    splitVoiceTextIntoChunks: mocks.splitVoiceTextIntoChunks,
    collectVoiceSamples: mocks.collectVoiceSamples,
    recordVoiceSample: mocks.recordVoiceSample,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
    recordInteraction: vi.fn(() => ({ history: [] })),
    VoiceGenerationRuntime: class {
      private packet: any = null;
      private listeners = new Set<(packet: any) => void>();

      subscribe(listener: (packet: any) => void) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      }

      enqueue(spec: any) {
        this.packet = {
          kind: 'voice_progress_packet',
          job_id: spec.jobId,
          status: 'queued',
          progress: { current: 0, total: 1, percent: 0, unit: 'steps' },
          updated_at: new Date().toISOString(),
        };
        const api = {
          report: (update: any) => {
            this.packet = {
              kind: 'voice_progress_packet',
              job_id: spec.jobId,
              status: update.status,
              progress: update.progress,
              message: update.message,
              artifact_refs: update.artifact_refs,
              updated_at: new Date().toISOString(),
            };
            for (const listener of this.listeners) listener(this.packet);
            return this.packet;
          },
          isCancelled: () => false,
        };
        Promise.resolve(spec.run(api)).then((result: any) => {
          this.packet = {
            kind: 'voice_progress_packet',
            job_id: spec.jobId,
            status: 'completed',
            progress: { current: 1, total: 1, percent: 100, unit: 'steps' },
            artifact_refs: result?.artifactRefs || [],
            updated_at: new Date().toISOString(),
          };
          for (const listener of this.listeners) listener(this.packet);
        });
        return this.packet;
      }

      getPacket() {
        return this.packet;
      }
    },
    pathResolver: {
      sharedTmp: vi.fn((value: string) => `/tmp/${value}`),
      rootResolve: vi.fn((value: string) => value),
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
    expect(mocks.withRetry).toHaveBeenCalled();
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
    expect(result.artifact_refs).toEqual(['/tmp/voice-generation/req-1.wav']);
    expect(result.progress_packets.length).toBeGreaterThan(0);
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'say',
      ['-v', 'Kyoko', '-r', '180', '-o', '/tmp/voice-generation/req-1.wav', 'hello world'],
    );
    expect(mocks.withRetry).toHaveBeenCalled();
  });

  it('blocks generate_voice when personal voice is required but engine falls back', async () => {
    mocks.getVoiceProfileRecord.mockReturnValueOnce({
      profile_id: 'user-ja-voice',
      display_name: 'User Japanese Voice',
      tier: 'personal',
      languages: ['ja'],
      default_engine_id: 'open_voice_clone',
      status: 'active',
    });
    mocks.resolveVoiceEngineForPlatform.mockReturnValueOnce({
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
    });
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'generate_voice',
      request_id: 'req-strict',
      text: 'hello world',
      profile_ref: { profile_id: 'user-ja-voice' },
      engine: { engine_id: 'open_voice_clone' },
      rendering: {
        language: 'ja',
        chunking: {
          max_chunk_chars: 20,
          crossfade_ms: 50,
          preserve_paralinguistic_tags: true,
        },
      },
      routing: { personal_voice_mode: 'require_personal_voice' },
      delivery: {
        mode: 'artifact',
        format: 'wav',
        emit_progress_packets: true,
      },
    } as any);

    expect(result).toEqual(expect.objectContaining({
      status: 'blocked',
      request_id: 'req-strict',
      engine_id: 'open_voice_clone',
      resolved_engine_id: 'local_say',
      fallback_detected: true,
      personal_voice_mode: 'require_personal_voice',
    }));
    expect(mocks.safeExec).not.toHaveBeenCalledWith(
      'say',
      expect.arrayContaining(['hello world']),
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

  it('collects voice samples into governed staging', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'collect_voice_samples',
      request_id: 'collect-1',
      profile_draft: {
        profile_id: 'user-ja-voice',
        display_name: 'User JA',
        tier: 'personal',
        languages: ['ja'],
        default_engine_id: 'open_voice_clone',
      },
      samples: [
        { sample_id: 's1', path: 'Downloads/sample-1.wav', language: 'ja' },
        { sample_id: 's2', path: 'Downloads/sample-2.wav', language: 'ja' },
      ],
    } as any);

    expect(result).toEqual(expect.objectContaining({
      status: 'succeeded',
      action: 'collect_voice_samples',
      request_id: 'collect-1',
    }));
    expect(result.collection_manifest_path).toContain('/tmp/voice-sample-collection/collect-1/');
    expect(mocks.collectVoiceSamples).toHaveBeenCalledWith(expect.objectContaining({
      action: 'collect_voice_samples',
      request_id: 'collect-1',
    }));
  });

  it('records a voice sample through the recorder bridge', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'record_voice_sample',
      request_id: 'rec-1',
      sample_id: 's1',
      duration_sec: 10,
      prompt_text: 'Please introduce yourself.',
    } as any);

    expect(result).toEqual(expect.objectContaining({
      status: 'succeeded',
      action: 'record_voice_sample',
      request_id: 'rec-1',
      sample_id: 's1',
      duration_sec: 10,
    }));
    expect(mocks.recordVoiceSample).toHaveBeenCalledWith(expect.objectContaining({
      action: 'record_voice_sample',
      request_id: 'rec-1',
      sample_id: 's1',
    }));
  });

  it('collects and registers voice profile in one action', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'collect_and_register_voice_profile',
      request_id: 'collect-reg-1',
      profile: {
        profile_id: 'user-ja-voice',
        display_name: 'User JA',
        tier: 'personal',
        languages: ['ja'],
        default_engine_id: 'open_voice_clone',
      },
      samples: [
        { sample_id: 's1', path: 'Downloads/sample-1.wav', language: 'ja' },
        { sample_id: 's2', path: 'Downloads/sample-2.wav', language: 'ja' },
        { sample_id: 's3', path: 'Downloads/sample-3.wav', language: 'ja' },
      ],
    } as any);

    expect(result).toEqual(expect.objectContaining({
      status: 'succeeded',
      action: 'collect_and_register_voice_profile',
      request_id: 'collect-reg-1',
    }));
    expect(result.collection.registration_candidate.samples).toHaveLength(3);
    expect(result.registration).toEqual(expect.objectContaining({
      status: 'succeeded',
      action: 'register_voice_profile',
      request_id: 'collect-reg-1',
    }));
    expect(mocks.collectVoiceSamples).toHaveBeenCalledWith(expect.objectContaining({
      action: 'collect_voice_samples',
      request_id: 'collect-reg-1',
    }));
  });
});

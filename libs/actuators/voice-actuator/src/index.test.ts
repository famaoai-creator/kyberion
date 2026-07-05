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
  getVoiceEngineRegistry: vi.fn(() => ({
    version: 'test',
    default_engine_id: 'mlx_audio_qwen3',
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
      },
      {
        engine_id: 'mlx_audio_qwen3',
        display_name: 'mlx-audio Qwen3-TTS (ICL Voice Clone)',
        kind: 'voice_clone_service',
        provider: 'mlx_audio',
        status: 'active',
        platforms: ['darwin'],
        supports: {
          list_voices: false,
          playback: true,
          artifact_formats: ['wav'],
        },
        fallback_engine_id: 'local_say',
      },
    ],
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
  safeExistsSync: vi.fn(
    (path: string) =>
      String(path).includes('espeak-ng') || String(path).includes('/tmp/voice-generation/')
  ),
  safeStat: vi.fn(() => ({ size: 4096 })),
  safeMkdir: vi.fn(),
  safeWriteFile: vi.fn(),
  safeReadFile: vi.fn(),
  getWritableVoiceProfileRegistryForTier: vi.fn(() => ({
    registryPath: '/tmp/personal-voice-profile-registry.json',
    registry: {
      version: 'test',
      default_profile_id: '',
      profiles: [],
    },
  })),
  materializeVoiceProfileSampleRefs: vi.fn(() => [
    '/tmp/runtime/voice-profiles/user-ja-voice/s1.wav',
    '/tmp/runtime/voice-profiles/user-ja-voice/s2.wav',
    '/tmp/runtime/voice-profiles/user-ja-voice/s3.wav',
  ]),
  writeVoiceProfileRegistry: vi.fn(),
  retry: vi.fn(async (fn: () => Promise<any>) => fn()),
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
  createVirtualDeviceInventoryBridge: vi.fn(() => ({
    bridge_id: 'virtual-device-inventory-bridge',
    probe: vi.fn(async () => ({
      bridge_id: 'virtual-device-inventory-bridge',
      platform: 'darwin',
      available: true,
      inventory: {
        audio_inputs: [],
        audio_outputs: [
          {
            kind: 'audio-output',
            name: 'Built-in Output',
            platform: 'darwin',
            source: 'system_profiler',
            available: true,
          },
        ],
        cameras: [],
        virtual_audio_devices: [],
        virtual_cameras: [],
        notes: [],
      },
    })),
  })),
  createVirtualAudioOutputPlaybackBridge: vi.fn(() => ({
    bridge_id: 'virtual-audio-output-playback-bridge',
    probe: vi.fn(async () => ({
      bridge_id: 'virtual-audio-output-playback-bridge',
      platform: 'darwin',
      available: true,
      outputs: ['Built-in Output'],
    })),
    playOnOutputs: vi.fn(async (targets: string[], request?: { source_path?: string }) => ({
      bridge_id: 'virtual-audio-output-playback-bridge',
      platform: 'darwin',
      outputs: (targets || []).map((target) => ({
        device_name: target,
        status: 'played',
        source_path: request?.source_path || '/tmp/voice-playback.wav',
        tone_path: request?.source_path || '/tmp/voice-playback.wav',
        selected_backend: 'swift-output-switch',
        output: 'played',
      })),
    })),
  })),
  listToolRuntimeInventory: vi.fn(() => ({
    version: '1.0.0',
    platform: 'darwin',
    requested_mode: 'trial',
    default_tool_id: 'mflux',
    items: [
      {
        tool: {
          tool_id: 'mlx_audio',
          display_name: 'mlx-audio TTS Runtime',
          ecosystem: 'python',
          status: 'active',
          platforms: ['darwin'],
          supported_modes: ['trial', 'approved_install', 'installed', 'pinned'],
          trial_backend: {
            kind: 'system',
            command: 'python3',
            args: ['-c', 'import mlx_audio; print("ok")'],
          },
          install_backend: { kind: 'uv', command: 'uv', args: ['pip', 'install', 'mlx-audio'] },
          installed_backend: {
            kind: 'system',
            command: 'python3',
            args: ['-c', 'import mlx_audio; print("ok")'],
          },
          managed_env_subpath: 'tool-runtimes/mlx-audio',
        },
        state: null,
        requested_mode: 'trial',
        lifecycle_stage: 'trial',
        selected_action: 'run_trial',
        selected_backend: {
          kind: 'system',
          command: 'python3',
          args: ['-c', 'import mlx_audio; print("ok")'],
        },
        trial_backend: {
          kind: 'system',
          command: 'python3',
          args: ['-c', 'import mlx_audio; print("ok")'],
        },
        install_backend: { kind: 'uv', command: 'uv', args: ['pip', 'install', 'mlx-audio'] },
        installed_backend: {
          kind: 'system',
          command: 'python3',
          args: ['-c', 'import mlx_audio; print("ok")'],
        },
        installed: false,
        requires_install: false,
        managed_env_path: '/tmp/tool-runtimes/mlx-audio',
        state_path: '/tmp/tool-runtimes/mlx-audio/state.json',
        available_commands: ['python3', 'uv'],
        reason: 'using trial backend for mlx_audio',
      },
      {
        tool: {
          tool_id: 'mlx_whisper',
          display_name: 'mlx-whisper STT Runtime',
          ecosystem: 'python',
          status: 'active',
          platforms: ['darwin'],
          supported_modes: ['trial', 'approved_install', 'installed', 'pinned'],
          trial_backend: {
            kind: 'system',
            command: 'python3',
            args: ['-c', 'import mlx_whisper; print("ok")'],
          },
          install_backend: { kind: 'uv', command: 'uv', args: ['pip', 'install', 'mlx-whisper'] },
          installed_backend: {
            kind: 'system',
            command: 'python3',
            args: ['-c', 'import mlx_whisper; print("ok")'],
          },
          managed_env_subpath: 'tool-runtimes/mlx-whisper',
        },
        state: null,
        requested_mode: 'trial',
        lifecycle_stage: 'trial',
        selected_action: 'run_trial',
        selected_backend: {
          kind: 'system',
          command: 'python3',
          args: ['-c', 'import mlx_whisper; print("ok")'],
        },
        trial_backend: {
          kind: 'system',
          command: 'python3',
          args: ['-c', 'import mlx_whisper; print("ok")'],
        },
        install_backend: { kind: 'uv', command: 'uv', args: ['pip', 'install', 'mlx-whisper'] },
        installed_backend: {
          kind: 'system',
          command: 'python3',
          args: ['-c', 'import mlx_whisper; print("ok")'],
        },
        installed: false,
        requires_install: false,
        managed_env_path: '/tmp/tool-runtimes/mlx-whisper',
        state_path: '/tmp/tool-runtimes/mlx-whisper/state.json',
        available_commands: ['python3', 'uv'],
        reason: 'using trial backend for mlx_whisper',
      },
    ],
  })),
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
  const actual = await vi.importActual<typeof import('@agent/core')>('@agent/core');
  return {
    ...actual,
    compileSchemaFromPath: mocks.compileSchemaFromPath,
    getVoiceProfileRecord: mocks.getVoiceProfileRecord,
    getVoiceRuntimePolicy: mocks.getVoiceRuntimePolicy,
    getVoiceEngineRecord: mocks.getVoiceEngineRecord,
    getVoiceEngineRegistry: mocks.getVoiceEngineRegistry,
    resolveVoiceEngineForPlatform: mocks.resolveVoiceEngineForPlatform,
    getVoiceTtsLanguageConfig: mocks.getVoiceTtsLanguageConfig,
    safeExec: mocks.safeExec,
    safeExistsSync: mocks.safeExistsSync,
    safeStat: mocks.safeStat,
    safeMkdir: mocks.safeMkdir,
    safeWriteFile: mocks.safeWriteFile,
    safeReadFile: mocks.safeReadFile,
    getWritableVoiceProfileRegistryForTier: mocks.getWritableVoiceProfileRegistryForTier,
    materializeVoiceProfileSampleRefs: mocks.materializeVoiceProfileSampleRefs,
    writeVoiceProfileRegistry: mocks.writeVoiceProfileRegistry,
    retry: mocks.retry,
    getVoiceSampleIngestionPolicy: mocks.getVoiceSampleIngestionPolicy,
    validateVoiceProfileRegistration: mocks.validateVoiceProfileRegistration,
    splitVoiceTextIntoChunks: mocks.splitVoiceTextIntoChunks,
    createVirtualDeviceInventoryBridge: mocks.createVirtualDeviceInventoryBridge,
    createVirtualAudioOutputPlaybackBridge: mocks.createVirtualAudioOutputPlaybackBridge,
    listToolRuntimeInventory: mocks.listToolRuntimeInventory,
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
    mocks.safeExec.mockImplementation((command: string) => {
      if (command === 'ffprobe') return '1.2';
      return '';
    });
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

    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        language: 'ja',
        voice: 'Kyoko',
        rate: 180,
        resolved_engine_id: 'local_say',
        mode: 'speaker_verification',
      })
    );
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'say',
      expect.arrayContaining([
        '-v',
        'Kyoko',
        '-r',
        '180',
        '-o',
        expect.stringContaining('/tmp/voice-generation/'),
        'hello world',
      ])
    );
    expect(mocks.createVirtualAudioOutputPlaybackBridge).toHaveBeenCalled();
    expect(mocks.retry).toHaveBeenCalled();
  });

  it('reports governed voice runtime health', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      action: 'health',
      params: { requested_mode: 'trial' },
    } as any);

    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        action: 'health',
        requested_mode: 'trial',
      })
    );
    expect(result.voice_engine_registry).toEqual(
      expect.objectContaining({
        version: 'test',
        default_engine_id: 'mlx_audio_qwen3',
        active_engine_count: 2,
      })
    );
    expect(result.tool_runtimes.items.mlx_audio).toEqual(
      expect.objectContaining({
        lifecycle_stage: 'trial',
        selected_action: 'run_trial',
      })
    );
    expect(result.tool_runtimes.items.mlx_whisper).toEqual(
      expect.objectContaining({
        lifecycle_stage: 'trial',
        selected_action: 'run_trial',
      })
    );
    expect(mocks.listToolRuntimeInventory).toHaveBeenCalledWith('trial');
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

    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        request_id: 'req-1',
        engine_id: 'local_say',
        resolved_engine_id: 'local_say',
        chunks: 2,
        delivery_mode: 'artifact_and_playback',
      })
    );
    expect(result.artifact_refs).toEqual(['/tmp/voice-generation/req-1.wav']);
    expect(result.speaker_verification).toEqual([
      expect.objectContaining({
        playback_source_path: '/tmp/voice-generation/req-1.wav',
        verification: expect.objectContaining({
          playback_source_path: '/tmp/voice-generation/req-1.wav',
        }),
      }),
    ]);
    expect(result.progress_packets.length).toBeGreaterThan(0);
    expect(mocks.safeExec).toHaveBeenCalledWith('say', [
      '-v',
      'Kyoko',
      '-r',
      '180',
      '-o',
      '/tmp/voice-generation/req-1.wav',
      'hello world',
    ]);
    expect(mocks.createVirtualAudioOutputPlaybackBridge).toHaveBeenCalled();
    expect(mocks.retry).toHaveBeenCalled();
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

    expect(result).toEqual(
      expect.objectContaining({
        status: 'blocked',
        request_id: 'req-strict',
        engine_id: 'open_voice_clone',
        resolved_engine_id: 'local_say',
        fallback_detected: true,
        personal_voice_mode: 'require_personal_voice',
      })
    );
    expect(mocks.safeExec).not.toHaveBeenCalledWith('say', expect.arrayContaining(['hello world']));
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

    expect(result).toEqual(
      expect.objectContaining({
        status: 'blocked',
        action: 'register_voice_profile',
        request_id: 'reg-1',
        violations: ['missing sample language coverage for ja'],
      })
    );
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

    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        action: 'register_voice_profile',
        request_id: 'reg-2',
        registration_receipt_path: '/tmp/voice-profile-registration/reg-2.json',
      })
    );
    expect(mocks.safeMkdir).toHaveBeenCalledWith('/tmp/voice-profile-registration', {
      recursive: true,
    });
    expect(mocks.safeWriteFile).toHaveBeenCalled();
  });

  it('upserts personal profiles into the tier-local writable registry only', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'register_voice_profile',
      request_id: 'reg-upsert-1',
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
      policy: { allow_update: true },
    } as any);

    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        action: 'register_voice_profile',
        request_id: 'reg-upsert-1',
        upserted: true,
      })
    );
    expect(mocks.getWritableVoiceProfileRegistryForTier).toHaveBeenCalledWith('personal');
    expect(mocks.writeVoiceProfileRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        default_profile_id: 'user-ja-voice',
        profiles: [expect.objectContaining({ profile_id: 'user-ja-voice', tier: 'personal' })],
      }),
      '/tmp/personal-voice-profile-registry.json'
    );
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

    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        action: 'collect_voice_samples',
        request_id: 'collect-1',
      })
    );
    expect(result.collection_manifest_path).toContain('/tmp/voice-sample-collection/collect-1/');
    expect(mocks.collectVoiceSamples).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'collect_voice_samples',
        request_id: 'collect-1',
      })
    );
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

    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        action: 'record_voice_sample',
        request_id: 'rec-1',
        sample_id: 's1',
        duration_sec: 10,
      })
    );
    expect(mocks.recordVoiceSample).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'record_voice_sample',
        request_id: 'rec-1',
        sample_id: 's1',
      })
    );
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

    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        action: 'collect_and_register_voice_profile',
        request_id: 'collect-reg-1',
      })
    );
    expect(result.collection.registration_candidate.samples).toHaveLength(3);
    expect(result.registration).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        action: 'register_voice_profile',
        request_id: 'collect-reg-1',
      })
    );
    expect(mocks.collectVoiceSamples).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'collect_voice_samples',
        request_id: 'collect-reg-1',
      })
    );
  });

  it('supports dry-run profile collection and registration without touching the registry', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'collect_and_register_voice_profile',
      request_id: 'collect-reg-dry-run',
      dry_run: true,
      profile: {
        profile_id: 'user-ja-voice',
        display_name: 'User JA',
        tier: 'personal',
        languages: ['ja'],
        default_engine_id: 'open_voice_clone',
      },
      samples: [],
    } as any);

    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        action: 'collect_and_register_voice_profile',
        request_id: 'collect-reg-dry-run',
        dry_run: true,
      })
    );
    expect(result.collection.summary.sample_count).toBe(0);
    expect(result.registration.sample_refs).toEqual([]);
    expect(mocks.collectVoiceSamples).not.toHaveBeenCalled();
  });

  it('supports dry-run generation without a registered profile or playback runtime', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'generate_voice',
      request_id: 'req-dry-run',
      dry_run: true,
      text: 'hello world',
      profile_ref: { profile_id: 'missing-profile' },
      engine: { engine_id: 'local_say' },
      rendering: { language: 'ja' },
      delivery: {
        mode: 'artifact',
        format: 'wav',
        artifact_path: '/tmp/voice-onboarding-check.wav',
        emit_progress_packets: true,
      },
    } as any);

    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        request_id: 'req-dry-run',
        profile_id: 'missing-profile',
        dry_run: true,
      })
    );
    expect(result.artifact_refs).toEqual(['/tmp/voice-onboarding-check.wav']);
    expect(mocks.safeExec).not.toHaveBeenCalled();
    expect(mocks.createVirtualAudioOutputPlaybackBridge).not.toHaveBeenCalled();
  });
});

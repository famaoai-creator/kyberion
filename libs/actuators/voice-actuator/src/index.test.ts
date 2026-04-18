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
  getVoiceTtsLanguageConfig: vi.fn(() => ({
    voice: 'Kyoko',
    rate: 180,
  })),
  safeExec: vi.fn(() => ''),
  safeMkdir: vi.fn(),
  safeReadFile: vi.fn(),
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
    getVoiceTtsLanguageConfig: mocks.getVoiceTtsLanguageConfig,
    safeExec: mocks.safeExec,
    safeMkdir: mocks.safeMkdir,
    safeReadFile: mocks.safeReadFile,
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
});

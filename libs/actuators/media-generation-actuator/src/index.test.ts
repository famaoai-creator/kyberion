import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath, pathResolver } from '@agent/core';

const mocks = vi.hoisted(() => ({
  safeReadFile: vi.fn(),
  safeWriteFile: vi.fn(),
  executeServicePreset: vi.fn(),
  compileMusicGenerationADF: vi.fn(),
  compileImageGenerationADF: vi.fn(),
  compileVideoGenerationADF: vi.fn(),
  secureFetch: vi.fn(),
  safeCopyFileSync: vi.fn(),
  safeExistsSync: vi.fn(),
  safeMkdir: vi.fn(),
}));
const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual('@agent/core') as any;
  return {
    ...actual,
    safeReadFile: mocks.safeReadFile,
    safeWriteFile: mocks.safeWriteFile,
    executeServicePreset: mocks.executeServicePreset,
    compileMusicGenerationADF: mocks.compileMusicGenerationADF,
    compileImageGenerationADF: mocks.compileImageGenerationADF,
    compileVideoGenerationADF: mocks.compileVideoGenerationADF,
    secureFetch: mocks.secureFetch,
    safeCopyFileSync: mocks.safeCopyFileSync,
    safeExistsSync: mocks.safeExistsSync,
    safeMkdir: mocks.safeMkdir,
  };
});

describe('media-generation-actuator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('delegates actions to the media-generation service preset', async () => {
    mocks.executeServicePreset.mockResolvedValue({ prompt_id: 'abc123' });
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      action: 'generate_image',
      params: { workflow_path: 'active/shared/tmp/image-workflow.json' },
    });

    expect(mocks.executeServicePreset).toHaveBeenCalledWith('media-generation', 'generate_image', {
      workflow_path: 'active/shared/tmp/image-workflow.json',
    });
    expect(result).toEqual({ prompt_id: 'abc123' });
  });

  it('can await image generation completion and return the generated artifact', async () => {
    mocks.executeServicePreset.mockResolvedValue({ prompt_id: 'img-123' });
    mocks.secureFetch.mockResolvedValue({
      'img-123': {
        status: { completed: true },
        outputs: {
          '201': {
            images: [
              {
                filename: 'country-cover_00001_.png',
                type: 'output',
              },
            ],
          },
        },
      },
    });
    mocks.safeExistsSync.mockReturnValue(true);

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'generate_image',
      params: {
        workflow: { '201': { class_type: 'SaveImage' } },
        await_completion: true,
        target_path: 'active/shared/exports/country-cover.png',
        poll_interval_ms: 1,
      },
    });

    expect(mocks.executeServicePreset).toHaveBeenCalledWith('media-generation', 'generate_image', expect.objectContaining({
      workflow: { '201': { class_type: 'SaveImage' } },
    }));
    expect(mocks.safeCopyFileSync).toHaveBeenCalledWith(
      '/Users/famaoai/Documents/comfy/ComfyUI/output/country-cover_00001_.png',
      'active/shared/exports/country-cover.png',
    );
    expect(result).toEqual(expect.objectContaining({
      action: 'generate_image',
      prompt_id: 'img-123',
      copied_to: 'active/shared/exports/country-cover.png',
      artifact: expect.objectContaining({
        filename: 'country-cover_00001_.png',
      }),
    }));
  });

  it('compiles image ADFs before dispatching generation', async () => {
    mocks.compileImageGenerationADF.mockReturnValue({
      workflow: { '7': { class_type: 'SaveImage' } },
      resolved: { filename_prefix: 'cover' },
    });
    mocks.executeServicePreset.mockResolvedValue({ prompt_id: 'img-234' });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'generate_image',
      params: {
        image_adf: {
          kind: 'image-generation-adf',
          version: '1.0.0',
          prompt: 'country road',
          canvas: { width: 1024, height: 1024 },
          output: { format: 'png' },
        },
      },
    });

    expect(mocks.compileImageGenerationADF).toHaveBeenCalled();
    expect(result).toEqual({
      prompt_id: 'img-234',
      status: 'submitted',
      compiled_generation_request: { filename_prefix: 'cover' },
    });
  });

  it('compiles music ADFs, waits for completion, and returns the generated artifact', async () => {
    mocks.compileMusicGenerationADF.mockReturnValue({
      workflow: { '111': { class_type: 'SaveAudioMP3' } },
      resolved: { filename_prefix: 'anniversary-song', duration_sec: 180 },
    });
    mocks.executeServicePreset.mockResolvedValue({ prompt_id: 'music-123' });
    mocks.secureFetch.mockResolvedValue({
      'music-123': {
        status: { completed: true },
        outputs: {
          '111': {
            audio: [
              {
                filename: 'anniversary-song_00001_.mp3',
                subfolder: 'audio',
                type: 'output',
              },
            ],
          },
        },
      },
    });
    mocks.safeExistsSync.mockReturnValue(true);

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'generate_music',
      params: {
        music_adf: {
          kind: 'music-generation-adf',
          version: '1.0.0',
          style: { genre: 'country' },
          composition: { duration_sec: 180 },
          output: { format: 'mp3', target_path: 'active/shared/exports/anniversary-song.mp3' },
        },
        poll_interval_ms: 1,
      },
    });

    expect(mocks.compileMusicGenerationADF).toHaveBeenCalled();
    expect(mocks.executeServicePreset).toHaveBeenCalledWith('media-generation', 'generate_music', expect.objectContaining({
      workflow: { '111': { class_type: 'SaveAudioMP3' } },
    }));
    expect(mocks.safeCopyFileSync).toHaveBeenCalledWith(
      '/Users/famaoai/Documents/comfy/ComfyUI/output/audio/anniversary-song_00001_.mp3',
      'active/shared/exports/anniversary-song.mp3',
    );
    expect(result).toEqual(expect.objectContaining({
      prompt_id: 'music-123',
      copied_to: 'active/shared/exports/anniversary-song.mp3',
      artifact: expect.objectContaining({
        filename: 'anniversary-song_00001_.mp3',
      }),
    }));
  });

  it('can submit and persist a generation job for later tracking', async () => {
    mocks.compileMusicGenerationADF.mockReturnValue({
      workflow: { '111': { class_type: 'SaveAudioMP3' } },
      resolved: { filename_prefix: 'anniversary-song', duration_sec: 180 },
    });
    mocks.executeServicePreset.mockResolvedValue({ prompt_id: 'music-123' });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'submit_generation',
      params: {
        action: 'generate_music',
        params: {
          music_adf: {
            kind: 'music-generation-adf',
            version: '1.0.0',
            style: { genre: 'country' },
            composition: { duration_sec: 180 },
            output: { format: 'mp3' },
          },
        },
      },
    });

    expect(result).toEqual(expect.objectContaining({
      kind: 'generation-job',
      action: 'generate_music',
      status: 'submitted',
      provider: expect.objectContaining({
        prompt_id: 'music-123',
      }),
    }));
    expect(mocks.safeWriteFile).toHaveBeenCalled();
  });

  it('can refresh a submitted generation job to succeeded from provider history', async () => {
    mocks.safeReadFile.mockReturnValue(JSON.stringify({
      kind: 'generation-job',
      job_id: 'genjob-generate_music-1',
      action: 'generate_music',
      status: 'submitted',
      provider: { engine: 'comfyui', prompt_id: 'music-123' },
      request: {
        target_path: 'active/shared/exports/anniversary-song.mp3',
      },
      result: {
        compiled_music_adf: { filename_prefix: 'anniversary-song' },
      },
      created_at: '2026-03-22T00:00:00.000Z',
    }));
    mocks.secureFetch.mockResolvedValue({
      'music-123': {
        status: { completed: true },
        outputs: {
          '111': {
            audio: [
              {
                filename: 'anniversary-song_00001_.mp3',
                subfolder: 'audio',
                type: 'output',
              },
            ],
          },
        },
      },
    });
    mocks.safeExistsSync.mockReturnValue(true);

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'get_generation_job',
      params: {
        job_id: 'genjob-generate_music-1',
      },
    });

    expect(result).toEqual(expect.objectContaining({
      job_id: 'genjob-generate_music-1',
      status: 'succeeded',
      result: expect.objectContaining({
        copied_to: 'active/shared/exports/anniversary-song.mp3',
      }),
    }));
    expect(mocks.safeWriteFile).toHaveBeenCalled();
  });

  it('marks a failed generation job as retrying when retry budget remains', async () => {
    mocks.safeReadFile.mockReturnValue(JSON.stringify({
      kind: 'generation-job',
      job_id: 'genjob-generate_music-2',
      action: 'generate_music',
      status: 'submitted',
      provider: { engine: 'comfyui', prompt_id: 'music-456' },
      request: {
        workflow: { '111': { class_type: 'SaveAudioMP3' } },
      },
      retry_policy: { max_attempts: 2, backoff_seconds: 0 },
      attempts: 1,
      created_at: '2026-03-22T00:00:00.000Z',
    }));
    mocks.secureFetch.mockRejectedValue(new Error('provider unavailable'));
    mocks.executeServicePreset.mockResolvedValue({ prompt_id: 'music-789' });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'get_generation_job',
      params: { job_id: 'genjob-generate_music-2' },
    });

    expect(mocks.executeServicePreset).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      job_id: 'genjob-generate_music-2',
      status: 'retrying',
      next_retry_at: expect.any(String),
    }));
  });

  it('resumes a retrying generation job once its backoff window has elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-22T00:01:00.000Z'));
    mocks.safeReadFile.mockReturnValue(JSON.stringify({
      kind: 'generation-job',
      job_id: 'genjob-generate_music-3',
      action: 'generate_music',
      status: 'retrying',
      provider: { engine: 'comfyui', prompt_id: 'music-456' },
      request: {
        workflow: { '111': { class_type: 'SaveAudioMP3' } },
      },
      result: {
        error: 'provider unavailable',
      },
      retry_policy: { max_attempts: 2, backoff_seconds: 30 },
      attempts: 1,
      next_retry_at: '2026-03-22T00:00:30.000Z',
      created_at: '2026-03-22T00:00:00.000Z',
    }));
    mocks.executeServicePreset.mockResolvedValue({ prompt_id: 'music-789' });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'get_generation_job',
      params: { job_id: 'genjob-generate_music-3' },
    });

    expect(mocks.executeServicePreset).toHaveBeenCalledWith('media-generation', 'generate_music', expect.objectContaining({
      workflow: { '111': { class_type: 'SaveAudioMP3' } },
    }));
    expect(result).toEqual(expect.objectContaining({
      job_id: 'genjob-generate_music-3',
      status: 'submitted',
      attempts: 2,
      provider: expect.objectContaining({ prompt_id: 'music-789' }),
    }));
    vi.useRealTimers();
  });

  it('emits media generation actions that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.join(pathResolver.rootDir(), 'schemas/media-generation-action.schema.json'));

    expect(
      validate({
        action: 'generate_image',
        params: {
          workflow_path: 'active/shared/tmp/image-workflow.json',
        },
      }),
      JSON.stringify(validate.errors || []),
    ).toBe(true);

    expect(
      validate({
        action: 'submit_generation',
        params: {
          action: 'generate_music',
          params: {
            music_adf: {
              kind: 'music-generation-adf',
              version: '1.0.0',
            },
          },
        },
      }),
      JSON.stringify(validate.errors || []),
    ).toBe(true);
  });

  it('rejects unsupported media generation actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.join(pathResolver.rootDir(), 'schemas/media-generation-action.schema.json'));

    expect(
      validate({
        action: 'unsupported',
        params: {},
      }),
    ).toBe(false);
  });

  it('emits voice-generation-adf requests that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.join(pathResolver.rootDir(), 'knowledge/public/schemas/voice-generation-adf.schema.json'));

    expect(validate({
      action: 'generate_voice',
      request_id: 'req-schema-1',
      text: 'hello world',
      profile_ref: {
        profile_id: 'operator-ja-default',
      },
      engine: {
        engine_id: 'local_say',
      },
      rendering: {
        language: 'ja',
        chunking: {
          max_chunk_chars: 200,
          crossfade_ms: 50,
          preserve_paralinguistic_tags: true,
        },
      },
      delivery: {
        mode: 'artifact',
        format: 'wav',
        emit_progress_packets: true,
      },
    })).toBe(true);
  });
});

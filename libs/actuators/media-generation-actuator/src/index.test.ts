import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath, pathResolver } from '@agent/core';
import { describeOps, MEDIA_GENERATION_ACTIONS } from './op-catalog.js';

const mocks = vi.hoisted(() => ({
  safeReadFile: vi.fn(),
  safeWriteFile: vi.fn(),
  executeServicePreset: vi.fn(),
  compileMusicGenerationADF: vi.fn(),
  compileImageGenerationADF: vi.fn(),
  compileVideoGenerationADF: vi.fn(),
  generateImage: vi.fn(),
  secureFetch: vi.fn(),
  retry: vi.fn(async (fn: () => Promise<unknown>, _options?: unknown) => fn()),
  safeCopyFileSync: vi.fn(),
  safeExistsSync: vi.fn(),
  safeMkdir: vi.fn(),
  handleSystemAction: vi.fn(async () => ({
    media_recording: {
      status: 'succeeded',
      output_path: '/repo/capture.mp4',
    },
  })),
}));
const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;
const COMFY_OUTPUT_DIR = pathResolver.sharedTmp('comfy/output');

vi.mock('@agent/core', async () => {
  const actual = (await vi.importActual('@agent/core')) as any;
  return {
    ...actual,
    safeReadFile: mocks.safeReadFile,
    safeWriteFile: mocks.safeWriteFile,
    executeServicePreset: mocks.executeServicePreset,
    compileMusicGenerationADF: mocks.compileMusicGenerationADF,
    compileImageGenerationADF: mocks.compileImageGenerationADF,
    compileVideoGenerationADF: mocks.compileVideoGenerationADF,
    generateImage: mocks.generateImage,
    secureFetch: mocks.secureFetch,
    buildGovernedRetryOptions: vi.fn(({ manifestPath, defaults, override }: any) => {
      let retryPolicy = {};
      try {
        const manifest = JSON.parse(String(mocks.safeReadFile(manifestPath)));
        retryPolicy = manifest?.recovery_policy?.retry || {};
      } catch {
        retryPolicy = {};
      }
      return { ...defaults, ...retryPolicy, ...(override || {}), shouldRetry: vi.fn() };
    }),
    retry: mocks.retry,
    safeCopyFileSync: mocks.safeCopyFileSync,
    safeExistsSync: mocks.safeExistsSync,
    safeMkdir: mocks.safeMkdir,
  };
});

vi.mock('@actuator/system', () => ({
  handleAction: mocks.handleSystemAction,
}));

describe('prompt style pack injection (E2E-02 Task 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  async function prepare(action: string, params: Record<string, unknown>) {
    const helpers = await import('./media-generation-helpers.js');
    return helpers.preparePromptBasedGeneration(action, params);
  }

  it('appends palette/tone/avoid to prompt-based generation', async () => {
    const prepared = await prepare('generate_image', {
      prompt: 'a clean product hero shot',
      workflow: { nodes: [] },
    });

    expect(prepared.params.prompt).toContain('a clean product hero shot');
    expect(prepared.params.prompt).toContain('Style: palette=');
    expect(prepared.params.prompt).toContain('Avoid:');
  });

  it('adds a music mood line for generate_music', async () => {
    mocks.compileMusicGenerationADF.mockReturnValue({ workflow: { nodes: [] }, resolved: {} });
    const prepared = await prepare('generate_music', {
      prompt: 'uplifting corporate track',
      music_adf: { prompt: 'uplifting corporate track', output: {} },
    });

    expect(prepared.params.prompt).toContain('Music mood:');
    expect((prepared.params.music_adf as { prompt: string }).prompt).toContain('Style: palette=');
  });

  it('respects the no_style_pack opt-out', async () => {
    const prepared = await prepare('generate_image', {
      prompt: 'raw prompt',
      workflow: { nodes: [] },
      no_style_pack: true,
    });

    expect(prepared.params.prompt).toBe('raw prompt');
  });

  it('does not double-inject when the block is already present', async () => {
    const first = await prepare('generate_image', {
      prompt: 'hero shot',
      workflow: { nodes: [] },
    });
    const second = await prepare('generate_image', {
      prompt: first.params.prompt,
      workflow: { nodes: [] },
    });

    const occurrences = String(second.params.prompt).split('Style: palette=').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('media-generation-actuator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('uses the manifest recovery policy when polling generation history', async () => {
    mocks.executeServicePreset.mockResolvedValue({ prompt_id: 'img-123' });
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('media-generation-actuator/manifest.json')) {
        return JSON.stringify({
          recovery_policy: {
            retry: {
              maxRetries: 4,
              initialDelayMs: 250,
              maxDelayMs: 2000,
              factor: 3,
              jitter: false,
            },
            retryable_categories: ['network', 'timeout'],
          },
        });
      }
      return JSON.stringify({
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
    });
    mocks.safeExistsSync.mockReturnValue(true);
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

    const { handleAction } = await import('./index.js');
    await handleAction({
      action: 'generate_image',
      params: {
        workflow: { '201': { class_type: 'SaveImage' } },
        await_completion: true,
        target_path: 'active/shared/exports/country-cover.png',
        poll_interval_ms: 1,
      },
    });

    expect(mocks.retry).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        maxRetries: 4,
        initialDelayMs: 250,
        maxDelayMs: 2000,
        factor: 3,
        jitter: false,
        shouldRetry: expect.any(Function),
      })
    );
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
    expect(result).toEqual(
      expect.objectContaining({
        prompt_id: 'abc123',
        trace_summary: expect.objectContaining({
          spans: expect.any(Number),
        }),
      })
    );
  });

  it('uses the direct image bridge path and preserves the artifact format from the output path', async () => {
    mocks.safeExistsSync.mockReturnValue(true);
    mocks.generateImage.mockResolvedValue({
      status: 'succeeded',
      provider: 'comfyui',
      path: 'active/shared/exports/country-cover.png',
      elapsedMs: 42,
      promptId: 'bridge-prompt-1',
    });
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'generate_image',
      params: {
        prompt: 'country road',
        target_path: 'active/shared/exports/country-cover.png',
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        prompt_id: 'bridge-prompt-1',
        artifact: expect.objectContaining({
          format: 'png',
          path: 'active/shared/exports/country-cover.png',
        }),
        artifacts: expect.arrayContaining([expect.objectContaining({ format: 'png' })]),
        backend_id: 'comfyui',
      })
    );
    expect(mocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('country road'),
        targetPath: 'active/shared/exports/country-cover.png',
      })
    );
    expect(mocks.executeServicePreset).not.toHaveBeenCalled();
  });

  it('injects the creative style pack before direct image bridge execution', async () => {
    mocks.generateImage.mockResolvedValue({
      status: 'submitted',
      provider: 'comfyui',
      promptId: 'bridge-submitted-1',
    });
    const { handleAction } = await import('./index.js');

    await handleAction({
      action: 'generate_image',
      params: { prompt: 'direct hero image', await_completion: false },
    });

    expect(mocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Style: palette='),
      })
    );
  });

  it('preserves a submitted bridge result and never fabricates a missing artifact', async () => {
    mocks.generateImage.mockResolvedValue({
      status: 'submitted',
      provider: 'comfyui',
      promptId: 'bridge-submitted-2',
      path: 'active/shared/exports/not-created.png',
    });
    mocks.safeExistsSync.mockReturnValue(false);
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      action: 'generate_image',
      params: { prompt: 'submitted image', await_completion: false },
    });

    expect(result.status).toBe('submitted');
    expect(result.artifact).toBeNull();
    expect(result.artifacts).toEqual([]);
    mocks.safeExistsSync.mockReturnValue(true);
  });

  it('resolves video and music backends with their requested modality', async () => {
    const helpers = await import('./media-generation-helpers.js');

    expect(helpers.resolveGenerationBackend('generate_video', {})).toEqual(
      expect.objectContaining({ modality: 'video' })
    );
    expect(helpers.resolveGenerationBackend('generate_music', {})).toEqual(
      expect.objectContaining({ modality: 'music' })
    );
  });

  it('does not mark a job succeeded when artifact collection fails', async () => {
    mocks.safeReadFile.mockReturnValue(
      JSON.stringify({
        kind: 'generation-job',
        job_id: 'genjob-artifact-failure',
        action: 'generate_image',
        status: 'submitted',
        provider: { engine: 'comfyui', prompt_id: 'artifact-failure-1' },
        request: { workflow: { '1': { class_type: 'SaveImage' } } },
        created_at: '2026-03-22T00:00:00.000Z',
      })
    );
    mocks.secureFetch.mockResolvedValue({
      'artifact-failure-1': {
        status: { completed: true },
        outputs: {},
      },
    });
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      action: 'get_generation_job',
      params: { job_id: 'genjob-artifact-failure' },
    });

    expect(result.status).toBe('failed');
  });

  it('keeps a client wait timeout refreshable', async () => {
    mocks.safeReadFile.mockReturnValue(
      JSON.stringify({
        kind: 'generation-job',
        job_id: 'genjob-timeout-refresh',
        action: 'generate_image',
        status: 'submitted',
        provider: { engine: 'comfyui', prompt_id: 'timeout-refresh-1' },
        request: { workflow: { '1': { class_type: 'SaveImage' } } },
        created_at: '2026-03-22T00:00:00.000Z',
      })
    );
    mocks.secureFetch.mockResolvedValue({});
    const { handleAction } = await import('./index.js');

    const timedOut = await handleAction({
      action: 'wait_generation_job',
      params: { job_id: 'genjob-timeout-refresh', timeout_ms: 1, poll_interval_ms: 1 },
    });

    expect(timedOut.wait_status).toBe('timed_out');
    expect(timedOut.status).toBe('submitted');
  });

  it('does not query ComfyUI for a job owned by an unsupported provider', async () => {
    mocks.safeReadFile.mockReturnValue(
      JSON.stringify({
        kind: 'generation-job',
        job_id: 'genjob-provider-boundary',
        action: 'generate_image',
        status: 'submitted',
        provider: { engine: 'mflux', provider_job_id: 'mflux-job-1' },
        request: { workflow: { '1': { class_type: 'SaveImage' } } },
        created_at: '2026-03-22T00:00:00.000Z',
      })
    );
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      action: 'get_generation_job',
      params: { job_id: 'genjob-provider-boundary' },
    });

    expect(result.status).toBe('submitted');
    expect(result.provider_history_status).toBe('unsupported');
    expect(result.provider_history_provider).toBe('mflux');
    expect(mocks.secureFetch).not.toHaveBeenCalled();
  });

  it('rejects traversal in job and provider artifact paths', async () => {
    const helpers = await import('./media-generation-helpers.js');

    expect(() => helpers.generationJobPath('../outside')).toThrow();
    expect(() => helpers.generationJobPath('valid/job\\name')).toThrow();
    expect(() => helpers.resolveArtifactPath({ filename: '../outside.png' })).toThrow();
    expect(() => helpers.resolveArtifactPath({ filename: '/tmp/outside.png' })).toThrow();
  });

  it('keeps schema, manifest, handler, and op catalog action sets aligned', async () => {
    const actual = await vi.importActual<typeof import('@agent/core')>('@agent/core');
    const manifest = JSON.parse(
      String(
        actual.safeReadFile(
          pathResolver.rootResolve('libs/actuators/media-generation-actuator/manifest.json'),
          { encoding: 'utf8' }
        )
      )
    ) as { capabilities: Array<{ op: string }> };
    const actions = manifest.capabilities.map((capability) => capability.op);
    const catalogActions = describeOps().map((entry) => entry.op);

    expect(catalogActions.sort()).toEqual(actions.sort());
    expect([...MEDIA_GENERATION_ACTIONS].sort()).toEqual(actions.sort());
    const fixtures: Record<string, Record<string, unknown>> = {
      generate_image: { prompt: 'x' },
      generate_video: { workflow: {} },
      generate_music: { workflow: {} },
      run_workflow: { workflow: {} },
      submit_generation: { action: 'generate_image', params: { prompt: 'x' } },
      get_generation_job: { job_id: 'genjob-test' },
      wait_generation_job: { job_id: 'genjob-test' },
      collect_generation_artifact: { job_id: 'genjob-test' },
      capture_screen: { output: 'active/shared/tmp/capture.jpg' },
      capture_focused_window: { output: 'active/shared/tmp/capture.jpg' },
      record_screen: { output: 'active/shared/tmp/capture.mp4' },
      pipeline: { steps: [] },
    };
    for (const action of actions) {
      const request =
        action === 'pipeline'
          ? { action, ...fixtures[action] }
          : { action, params: fixtures[action] };
      expect(
        compileSchemaFromPath(
          new Ajv({ allErrors: true }),
          pathResolver.rootResolve('schemas/media-generation-action.schema.json')
        )(request),
        action
      ).toBe(true);
    }
  });

  it('uses the same await_completion rule for image, video, and music ADFs', async () => {
    const helpers = await import('./media-generation-helpers.js');
    mocks.compileImageGenerationADF.mockReturnValue({ workflow: { nodes: [] }, resolved: {} });
    mocks.compileVideoGenerationADF.mockReturnValue({ workflow: { nodes: [] }, resolved: {} });
    mocks.compileMusicGenerationADF.mockReturnValue({ workflow: { nodes: [] }, resolved: {} });

    for (const [action, key] of [
      ['generate_image', 'image_adf'],
      ['generate_video', 'video_adf'],
      ['generate_music', 'music_adf'],
    ] as const) {
      const prepared = helpers.preparePromptBasedGeneration(action, {
        [key]: { output: { await_completion: true } },
      });
      expect(helpers.resolveAwaitCompletion(action, prepared.params)).toBe(true);
    }
  });

  it('does not automatically resubmit non-retryable errors', async () => {
    mocks.safeReadFile.mockReturnValue(
      JSON.stringify({
        kind: 'generation-job',
        job_id: 'genjob-policy-error',
        action: 'generate_image',
        status: 'submitted',
        provider: { engine: 'comfyui', prompt_id: 'policy-error-1' },
        request: { workflow: { '1': { class_type: 'SaveImage' } } },
        retry_policy: { max_attempts: 3, backoff_seconds: 0 },
        attempts: 1,
        created_at: '2026-03-22T00:00:00.000Z',
      })
    );
    mocks.secureFetch.mockRejectedValue(new Error('policy_denied'));
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      action: 'get_generation_job',
      params: { job_id: 'genjob-policy-error' },
    });

    expect(result.status).toBe('failed');
    expect(result.retry_classification).toBe('policy_denied');
  });

  it('counts max_attempts as total attempts including the initial submission', async () => {
    mocks.safeReadFile.mockReturnValue(
      JSON.stringify({
        kind: 'generation-job',
        job_id: 'genjob-one-attempt',
        action: 'generate_image',
        status: 'submitted',
        provider: { engine: 'comfyui', prompt_id: 'one-attempt-1' },
        request: { workflow: { '1': { class_type: 'SaveImage' } } },
        retry_policy: { max_attempts: 1, backoff_seconds: 0 },
        attempts: 1,
        created_at: '2026-03-22T00:00:00.000Z',
      })
    );
    mocks.secureFetch.mockRejectedValue(new Error('provider unavailable'));
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      action: 'get_generation_job',
      params: { job_id: 'genjob-one-attempt' },
    });

    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(1);
    expect(mocks.executeServicePreset).not.toHaveBeenCalled();
  });

  it('aggregates pipeline step failures with step results', async () => {
    mocks.executeServicePreset.mockResolvedValueOnce({
      status: 'failed',
      action: 'generate_image',
    });
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      action: 'pipeline',
      continue_on_error: true,
      steps: [
        { action: 'generate_image', params: { workflow_path: 'active/shared/tmp/a.json' } },
        { action: 'record_screen', params: { output: 'active/shared/tmp/a.mp4' } },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual(expect.objectContaining({ status: 'failed' }));
    expect(mocks.handleSystemAction).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [expect.objectContaining({ op: 'record_screen' })],
      })
    );
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

    expect(mocks.executeServicePreset).toHaveBeenCalledWith(
      'media-generation',
      'generate_image',
      expect.objectContaining({
        workflow: { '201': { class_type: 'SaveImage' } },
      })
    );
    expect(mocks.safeCopyFileSync).toHaveBeenCalledWith(
      `${COMFY_OUTPUT_DIR}/country-cover_00001_.png`,
      'active/shared/exports/country-cover.png'
    );
    expect(result).toEqual(
      expect.objectContaining({
        action: 'generate_image',
        prompt_id: 'img-123',
        copied_to: 'active/shared/exports/country-cover.png',
        artifact: expect.objectContaining({
          filename: 'country-cover_00001_.png',
        }),
      })
    );
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
    expect(result).toEqual(
      expect.objectContaining({
        prompt_id: 'img-234',
        status: 'submitted',
        compiled_generation_request: { filename_prefix: 'cover' },
        trace_summary: expect.objectContaining({
          spans: expect.any(Number),
        }),
      })
    );
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
    expect(mocks.executeServicePreset).toHaveBeenCalledWith(
      'media-generation',
      'generate_music',
      expect.objectContaining({
        workflow: { '111': { class_type: 'SaveAudioMP3' } },
      })
    );
    expect(mocks.safeCopyFileSync).toHaveBeenCalledWith(
      `${COMFY_OUTPUT_DIR}/audio/anniversary-song_00001_.mp3`,
      'active/shared/exports/anniversary-song.mp3'
    );
    expect(result).toEqual(
      expect.objectContaining({
        prompt_id: 'music-123',
        copied_to: 'active/shared/exports/anniversary-song.mp3',
        artifact: expect.objectContaining({
          filename: 'anniversary-song_00001_.mp3',
        }),
      })
    );
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

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'generation-job',
        action: 'generate_music',
        status: 'submitted',
        provider: expect.objectContaining({
          prompt_id: 'music-123',
        }),
      })
    );
    expect(mocks.safeWriteFile).toHaveBeenCalled();
  });

  it('can refresh a submitted generation job to succeeded from provider history', async () => {
    mocks.safeReadFile.mockReturnValue(
      JSON.stringify({
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
      })
    );
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

    expect(result).toEqual(
      expect.objectContaining({
        job_id: 'genjob-generate_music-1',
        status: 'succeeded',
        result: expect.objectContaining({
          copied_to: 'active/shared/exports/anniversary-song.mp3',
        }),
      })
    );
    expect(mocks.safeWriteFile).toHaveBeenCalled();
  });

  it('marks a failed generation job as retrying when retry budget remains', async () => {
    mocks.safeReadFile.mockReturnValue(
      JSON.stringify({
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
      })
    );
    mocks.secureFetch.mockRejectedValue(new Error('provider unavailable'));
    mocks.executeServicePreset.mockResolvedValue({ prompt_id: 'music-789' });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'get_generation_job',
      params: { job_id: 'genjob-generate_music-2' },
    });

    expect(mocks.executeServicePreset).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        job_id: 'genjob-generate_music-2',
        status: 'retrying',
        next_retry_at: expect.any(String),
      })
    );
  });

  it('resumes a retrying generation job once its backoff window has elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-22T00:01:00.000Z'));
    mocks.safeReadFile.mockReturnValue(
      JSON.stringify({
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
      })
    );
    mocks.executeServicePreset.mockResolvedValue({ prompt_id: 'music-789' });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'get_generation_job',
      params: { job_id: 'genjob-generate_music-3' },
    });

    expect(mocks.executeServicePreset).toHaveBeenCalledWith(
      'media-generation',
      'generate_music',
      expect.objectContaining({
        workflow: { '111': { class_type: 'SaveAudioMP3' } },
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        job_id: 'genjob-generate_music-3',
        status: 'submitted',
        attempts: 2,
        provider: expect.objectContaining({ prompt_id: 'music-789' }),
      })
    );
    vi.useRealTimers();
  });

  it('emits media generation actions that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.join(pathResolver.rootDir(), 'schemas/media-generation-action.schema.json')
    );

    expect(
      validate({
        action: 'generate_image',
        params: {
          workflow_path: 'active/shared/tmp/image-workflow.json',
        },
      }),
      JSON.stringify(validate.errors || [])
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
      JSON.stringify(validate.errors || [])
    ).toBe(true);
  });

  it('rejects unsupported media generation actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.join(pathResolver.rootDir(), 'schemas/media-generation-action.schema.json')
    );

    expect(
      validate({
        action: 'unsupported',
        params: {},
      })
    ).toBe(false);
  });

  it('emits voice-generation-adf requests that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.join(
        pathResolver.rootDir(),
        'knowledge/product/schemas/voice-generation-adf.schema.json'
      )
    );

    expect(
      validate({
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
      })
    ).toBe(true);
  });

  it('validates every action example fixture against the discriminated action schema', async () => {
    const actual = await vi.importActual<typeof import('@agent/core')>('@agent/core');
    const catalog = JSON.parse(
      String(
        actual.safeReadFile(
          pathResolver.rootResolve(
            'libs/actuators/media-generation-actuator/examples/catalog.json'
          ),
          { encoding: 'utf8' }
        )
      )
    ) as { examples: Array<{ path: string; tags?: string[] }> };
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      pathResolver.rootResolve('schemas/media-generation-action.schema.json')
    );

    for (const example of catalog.examples) {
      if (example.tags?.includes('schedule')) continue;
      const fixture = JSON.parse(
        String(actual.safeReadFile(pathResolver.rootResolve(example.path), { encoding: 'utf8' }))
      ) as Record<string, unknown>;
      expect(validate(fixture), `${example.path}: ${JSON.stringify(validate.errors || [])}`).toBe(
        true
      );
    }
  });
});

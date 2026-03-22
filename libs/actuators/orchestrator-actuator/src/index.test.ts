import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeReadFile: vi.fn(),
  safeWriteFile: vi.fn(),
  safeExec: vi.fn(),
  safeMkdir: vi.fn(),
  safeExistsSync: vi.fn(),
  safeUnlinkSync: vi.fn(),
  safeSymlinkSync: vi.fn(),
  resolveVars: vi.fn((value: string) => value),
  evaluateCondition: vi.fn(),
  withRetry: vi.fn(async (fn: any) => fn()),
  derivePipelineStatus: vi.fn(() => 'succeeded'),
}));

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual('@agent/core') as any;
  return {
    ...actual,
    safeReadFile: mocks.safeReadFile,
    safeWriteFile: mocks.safeWriteFile,
    safeExec: mocks.safeExec,
    safeMkdir: mocks.safeMkdir,
    safeExistsSync: mocks.safeExistsSync,
    safeUnlinkSync: mocks.safeUnlinkSync,
    safeSymlinkSync: mocks.safeSymlinkSync,
    resolveVars: mocks.resolveVars,
    evaluateCondition: mocks.evaluateCondition,
    withRetry: mocks.withRetry,
    derivePipelineStatus: mocks.derivePipelineStatus,
  };
});

vi.mock('@agent/core/fs-utils', () => ({
  getAllFiles: vi.fn(() => []),
}));

describe('orchestrator-actuator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeExistsSync.mockReturnValue(true);
  });

  it('renders a music pipeline bundle into an execution plan set', async () => {
    const bundle = {
      kind: 'actuator-pipeline-bundle',
      archetype_id: 'generative-music-from-adf',
      status: 'ready',
      jobs: [
        {
          id: 'generate-anniversary-song',
          title: 'Generate Anniversary Song From Music ADF',
          actuator: 'media-generation-actuator',
          template_path: 'libs/actuators/media-generation-actuator/examples/music-adf-anniversary-country-ja.json',
          recommended_procedure: 'knowledge/public/procedures/media/generate-music-from-adf.md',
          parameter_overrides: {
            'params.music_adf.intent': 'updated_anniversary_song',
          },
          outputs: ['active/shared/exports/KyberionAnniversary15Country.mp3'],
        },
      ],
    };

    const template = {
      action: 'generate_music',
      params: {
        music_adf: {
          kind: 'music-generation-adf',
          version: '1.0.0',
          intent: '15th_wedding_anniversary_song',
          style: { genre: 'country' },
          composition: { duration_sec: 180 },
          output: { format: 'mp3' },
        },
      },
    };

    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('music-generation-pipeline-bundle.json')) return JSON.stringify(bundle);
      if (filePath.includes('music-adf-anniversary-country-ja.json')) return JSON.stringify(template);
      throw new Error(`unexpected read: ${filePath}`);
    });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'capture',
          op: 'read_json',
          params: {
            path: 'libs/actuators/orchestrator-actuator/examples/music-generation-pipeline-bundle.json',
            export_as: 'pipeline_bundle',
          },
        },
        {
          type: 'transform',
          op: 'pipeline_bundle_to_execution_plan_set',
          params: {
            from: 'pipeline_bundle',
            output_dir: 'active/shared/runtime/generated-pipelines/music-generation-demo',
            export_as: 'execution_plan_set',
          },
        },
        {
          type: 'apply',
          op: 'write_execution_plan_set',
          params: {
            from: 'execution_plan_set',
          },
        },
      ],
    } as any);

    const planSet = result.context.execution_plan_set;
    expect(planSet).toEqual(expect.objectContaining({
      kind: 'actuator-execution-plan-set',
      archetype_id: 'generative-music-from-adf',
      status: 'ready',
    }));
    expect(planSet.jobs[0]).toEqual(expect.objectContaining({
      actuator: 'media-generation-actuator',
      output_path: 'active/shared/runtime/generated-pipelines/music-generation-demo/generate-anniversary-song.json',
      rendered_pipeline: expect.objectContaining({
        action: 'generate_music',
        params: {
          music_adf: expect.objectContaining({
            intent: 'updated_anniversary_song',
          }),
        },
      }),
    }));
    expect(mocks.safeWriteFile).toHaveBeenCalledWith(
      'active/shared/runtime/generated-pipelines/music-generation-demo/generate-anniversary-song.json',
      expect.stringContaining('"intent": "updated_anniversary_song"'),
    );
  });

  it('renders an image pipeline bundle into an execution plan set', async () => {
    const bundle = {
      kind: 'actuator-pipeline-bundle',
      archetype_id: 'generative-image-from-adf',
      status: 'ready',
      jobs: [
        {
          id: 'generate-country-cover',
          title: 'Generate Country Cover Image From Image ADF',
          actuator: 'media-generation-actuator',
          template_path: 'libs/actuators/media-generation-actuator/examples/image-adf-country-cover.json',
          recommended_procedure: 'knowledge/public/procedures/media/generate-image-from-adf.md',
          parameter_overrides: {
            'params.image_adf.intent': 'updated_country_cover',
          },
          outputs: ['active/shared/exports/KyberionCountryCover.png'],
        },
      ],
    };

    const template = {
      action: 'generate_image',
      params: {
        image_adf: {
          kind: 'image-generation-adf',
          version: '1.0.0',
          intent: 'country_cover_art',
          prompt: 'golden hour country road',
          canvas: { width: 1024, height: 1024 },
          output: { format: 'png' },
        },
      },
    };

    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('image-generation-pipeline-bundle.json')) return JSON.stringify(bundle);
      if (filePath.includes('image-adf-country-cover.json')) return JSON.stringify(template);
      throw new Error(`unexpected read: ${filePath}`);
    });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'capture',
          op: 'read_json',
          params: {
            path: 'libs/actuators/orchestrator-actuator/examples/image-generation-pipeline-bundle.json',
            export_as: 'pipeline_bundle',
          },
        },
        {
          type: 'transform',
          op: 'pipeline_bundle_to_execution_plan_set',
          params: {
            from: 'pipeline_bundle',
            output_dir: 'active/shared/runtime/generated-pipelines/image-generation-demo',
            export_as: 'execution_plan_set',
          },
        },
        {
          type: 'apply',
          op: 'write_execution_plan_set',
          params: {
            from: 'execution_plan_set',
          },
        },
      ],
    } as any);

    const planSet = result.context.execution_plan_set;
    expect(planSet).toEqual(expect.objectContaining({
      kind: 'actuator-execution-plan-set',
      archetype_id: 'generative-image-from-adf',
      status: 'ready',
    }));
    expect(planSet.jobs[0]).toEqual(expect.objectContaining({
      actuator: 'media-generation-actuator',
      output_path: 'active/shared/runtime/generated-pipelines/image-generation-demo/generate-country-cover.json',
      rendered_pipeline: expect.objectContaining({
        action: 'generate_image',
        params: {
          image_adf: expect.objectContaining({
            intent: 'updated_country_cover',
          }),
        },
      }),
    }));
  });

  it('renders a video pipeline bundle into an execution plan set', async () => {
    const bundle = {
      kind: 'actuator-pipeline-bundle',
      archetype_id: 'generative-video-from-adf',
      status: 'ready',
      jobs: [
        {
          id: 'generate-drive-clip',
          title: 'Generate Drive Clip From Video ADF',
          actuator: 'media-generation-actuator',
          template_path: 'libs/actuators/media-generation-actuator/examples/video-adf-drive-clip.json',
          recommended_procedure: 'knowledge/public/procedures/media/generate-video-from-adf.md',
          parameter_overrides: {
            'params.video_adf.intent': 'updated_drive_clip',
          },
          outputs: ['active/shared/exports/KyberionDriveClip.mp4'],
        },
      ],
    };

    const template = {
      action: 'generate_video',
      params: {
        video_adf: {
          kind: 'video-generation-adf',
          version: '1.0.0',
          intent: 'country_drive_clip',
          prompt: 'cinematic driving shot',
          composition: { duration_sec: 5, fps: 24 },
          engine: { provider: 'comfyui', workflow_template: 'basic_text_clip' },
          output: { format: 'mp4' },
        },
      },
    };

    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('video-generation-pipeline-bundle.json')) return JSON.stringify(bundle);
      if (filePath.includes('video-adf-drive-clip.json')) return JSON.stringify(template);
      throw new Error(`unexpected read: ${filePath}`);
    });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'capture',
          op: 'read_json',
          params: {
            path: 'libs/actuators/orchestrator-actuator/examples/video-generation-pipeline-bundle.json',
            export_as: 'pipeline_bundle',
          },
        },
        {
          type: 'transform',
          op: 'pipeline_bundle_to_execution_plan_set',
          params: {
            from: 'pipeline_bundle',
            output_dir: 'active/shared/runtime/generated-pipelines/video-generation-demo',
            export_as: 'execution_plan_set',
          },
        },
        {
          type: 'apply',
          op: 'write_execution_plan_set',
          params: {
            from: 'execution_plan_set',
          },
        },
      ],
    } as any);

    const planSet = result.context.execution_plan_set;
    expect(planSet).toEqual(expect.objectContaining({
      kind: 'actuator-execution-plan-set',
      archetype_id: 'generative-video-from-adf',
      status: 'ready',
    }));
    expect(planSet.jobs[0]).toEqual(expect.objectContaining({
      actuator: 'media-generation-actuator',
      output_path: 'active/shared/runtime/generated-pipelines/video-generation-demo/generate-drive-clip.json',
      rendered_pipeline: expect.objectContaining({
        action: 'generate_video',
        params: {
          video_adf: expect.objectContaining({
            intent: 'updated_drive_clip',
          }),
        },
      }),
    }));
  });
});

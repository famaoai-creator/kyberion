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

  it('loads existing context and persists merged context to context_path', async () => {
    const root = process.cwd();
    const contextPath = 'active/shared/tmp/orchestrator-tests/context.json';
    const inputPath = 'active/shared/tmp/orchestrator-tests/input.json';
    const resolvedContextPath = `${root}/${contextPath}`;
    const resolvedInputPath = `${root}/${inputPath}`;

    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath === resolvedContextPath) return JSON.stringify({ existing: 'yes' });
      if (filePath === resolvedInputPath) return JSON.stringify({ answer: 42 });
      throw new Error(`unexpected read: ${filePath}`);
    });
    mocks.safeExistsSync.mockImplementation((filePath: string) => filePath === resolvedContextPath);

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'pipeline',
      context: {
        context_path: contextPath,
      },
      steps: [
        {
          type: 'capture',
          op: 'read_json',
          params: {
            path: inputPath,
            export_as: 'payload',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.existing).toBe('yes');
    expect(result.context.payload).toEqual({ answer: 42 });
    expect(mocks.safeWriteFile).toHaveBeenCalledWith(
      resolvedContextPath,
      expect.stringContaining('"payload"'),
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

  it('marks actuator jobs as failed when the actuator reports failed status in JSON', async () => {
    mocks.safeExec.mockImplementation((command: string, args?: string[]) => {
      if (command === 'node' && Array.isArray(args) && args[0]?.includes('media-actuator')) {
        return JSON.stringify({ status: 'failed', results: [{ status: 'failed', error: 'SAFE_IO_VIOLATION' }] });
      }
      return '';
    });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'transform',
          op: 'run_execution_plan_set',
          params: {
            from: 'execution_plan_set',
            export_as: 'run_report',
          },
        },
      ],
      context: {
        execution_plan_set: {
          jobs: [
            {
              id: 'job-1',
              actuator: 'media-actuator',
              output_path: 'active/shared/tmp/failing-job.json',
              rendered_pipeline: {
                action: 'generate_presentation',
                params: {},
              },
            },
          ],
        },
      },
    } as any);

    expect(result.context.run_report).toEqual(expect.objectContaining({
      status: 'partial',
      results: [
        expect.objectContaining({
          status: 'failed',
          error: 'Actuator reported status=failed',
        }),
      ],
    }));
  });

  it('infers required inputs from context aliases when building an execution brief', async () => {
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('actuator-request-archetypes.json')) {
        return JSON.stringify({
          default_archetype: 'project-document-pack',
          archetypes: [
            {
              id: 'project-document-pack',
              trigger_keywords: ['プロジェクト', 'project'],
              summary_template: 'Generate a project document pack.',
              normalized_scope: ['project-os'],
              target_actuators: ['orchestrator-actuator'],
              deliverables: ['project documents'],
              required_inputs: ['project name', 'delivery scope', 'phase or gate', 'related missions'],
            },
          ],
        });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'pipeline',
      context: {
        request_text: '新しいプロジェクト PRJ-SIM-2026 を開始します。',
        project_name: 'Simulation Project 2026',
        delivery_scope: 'project OS',
        phase: 'define',
        related_missions: ['MSN-BOOT-1'],
      },
      steps: [
        {
          type: 'transform',
          op: 'request_to_execution_brief',
          params: {
            export_as: 'brief',
          },
        },
      ],
    } as any);

    expect(result.context.brief.readiness).toBe('fully_automatable');
    expect(result.context.brief.missing_inputs).toEqual([]);
    expect(result.context.brief.inferred_inputs).toEqual([
      'project name',
      'delivery scope',
      'phase or gate',
      'related missions',
    ]);
  });

  it('falls back to brief when pipeline bundle step omits brief_from', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'pipeline',
      context: {
        resolution_plan: {
          kind: 'actuator-resolution-plan',
          archetype_id: 'project-document-pack',
          summary: 'Build project pack',
        },
        brief: {
          kind: 'actuator-execution-brief',
          archetype_id: 'project-document-pack',
          summary: 'Brief ready',
          missing_inputs: [],
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'resolution_plan_to_pipeline_bundle',
          params: {
            from: 'resolution_plan',
            export_as: 'bundle',
          },
        },
      ],
    } as any);

    expect(result.context.bundle.kind).toBe('actuator-pipeline-bundle');
    expect(result.context.bundle.status).toBe('ready');
  });

  it('preflights execution plan sets and repairs pipeline-shaped contracts before execution', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'pipeline',
      context: {
        execution_plan_set: {
          kind: 'actuator-execution-plan-set',
          archetype_id: 'structured-delivery',
          status: 'ready',
          output_dir: 'active/shared/runtime/generated-pipelines/preflight-demo',
          jobs: [
            {
              id: 'repairable-job',
              actuator: 'artifact-actuator',
              rendered_pipeline: {
                steps: [
                  {
                    type: 'apply',
                    op: 'write_file',
                    params: {
                      path: 'active/shared/tmp/test.txt',
                      from: 'payload',
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'preflight_execution_plan_set',
          params: {
            from: 'execution_plan_set',
            export_as: 'preflight',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.preflight.status).toBe('needs_clarification');
    expect(result.context.preflight.repair_count).toBeGreaterThan(0);
    expect(result.context.validated_execution_plan_set.jobs[0].output_path).toBe(
      'active/shared/runtime/generated-pipelines/preflight-demo/repairable-job.json',
    );
    expect(result.context.validated_execution_plan_set.jobs[0].rendered_pipeline).toEqual(
      expect.objectContaining({
        action: 'pipeline',
        context: {},
      }),
    );
  });

  it('blocks invalid execution plan sets with unresolved template variables before execution', async () => {
    mocks.safeExec.mockImplementation(() => {
      throw new Error('safeExec should not be called for invalid preflight');
    });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'pipeline',
      context: {
        execution_plan_set: {
          kind: 'actuator-execution-plan-set',
          archetype_id: 'structured-delivery',
          status: 'ready',
          jobs: [
            {
              id: 'invalid-job',
              actuator: 'artifact-actuator',
              output_path: 'active/shared/runtime/generated-pipelines/invalid-job.json',
              rendered_pipeline: {
                action: 'write_delivery_pack',
                params: {
                  packId: '{{delivery_pack_id}}',
                },
              },
            },
          ],
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'run_execution_plan_set',
          params: {
            from: 'execution_plan_set',
            export_as: 'run_report',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.execution_plan_preflight.status).toBe('invalid');
    expect(result.context.run_report.status).toBe('failed');
    expect(result.context.run_report.preflight_report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unresolved_template_variable',
        }),
      ]),
    );
    expect(mocks.safeExec).not.toHaveBeenCalled();
  });
});

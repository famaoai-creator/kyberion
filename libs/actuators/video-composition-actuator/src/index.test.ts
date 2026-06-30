import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  compileSchemaFromPath: vi.fn(() => {
    const validator: any = () => true;
    validator.errors = [];
    return validator;
  }),
  safeExec: vi.fn(() => '1'),
  safeExistsSync: vi.fn(() => true),
  safeStat: vi.fn(() => ({ size: 4096 })),
  safeMkdir: vi.fn(),
  safeWriteFile: vi.fn(),
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  getVideoCompositionTemplateRegistry: vi.fn(() => ({
    version: 'test',
    default_template_id: 'basic-title-card',
    templates: [
      {
        template_id: 'basic-title-card',
        display_name: 'Basic Title Card',
        status: 'active',
        renderer: 'builtin_html',
        supported_roles: ['hook', 'generic', 'cta'],
        required_content_fields: ['headline'],
        supported_output_formats: ['mp4'],
      },
    ],
  })),
  getVideoRenderRuntimePolicy: vi.fn(() => ({
    version: 'test',
    queue: { concurrency: 1, cancellation: 'queued_or_running' },
    progress: { throttle_ms: 0, min_percent_delta: 0, emit_heartbeat: true },
    bundle: { default_bundle_root: 'active/shared/tmp/video-composition', copy_declared_assets: false },
    render: { allowed_output_formats: ['mp4'], enable_backend_rendering: false, backend: 'none', quality: 'standard', command_timeout_ms: 300000 },
  })),
  safeReadFile: vi.fn(),
  compileNarratedVideoBriefToCompositionADF: vi.fn(() => ({
    kind: 'video-composition-adf',
    version: '1.0.0',
    composition: { duration_sec: 9, fps: 30, width: 1920, height: 1080 },
    scenes: [],
    output: { format: 'mp4', await_completion: true },
  })),
  compileVideoCompositionADF: vi.fn(() => ({
    kind: 'video-composition-render-plan',
    version: '1.0.0',
    composition_id: 'demo',
    source_kind: 'video-composition-adf',
    title: 'Kyberion',
    duration_sec: 9,
    fps: 30,
    width: 1920,
    height: 1080,
    background_color: '#07111f',
    output_format: 'mp4',
    bundle_dir: '/tmp/video-composition',
    index_html: '/tmp/video-composition/index.html',
    scenes: [
      { scene_id: 'hook', role: 'hook', start_sec: 0, duration_sec: 3, template_id: 'basic-title-card', template_display_name: 'Basic Title Card', output_html: 'compositions/hook.html', required_content_fields: ['headline'], content: { headline: 'Intent to Execution' }, asset_refs: [] },
      { scene_id: 'feature', role: 'feature', start_sec: 3, duration_sec: 3, template_id: 'promo-spot', template_display_name: 'Promo Spot', output_html: 'compositions/feature.html', required_content_fields: ['headline'], content: { headline: 'Structure first' }, asset_refs: [] },
      { scene_id: 'cta', role: 'cta', start_sec: 6, duration_sec: 3, template_id: 'logo-outro', template_display_name: 'Logo Outro', output_html: 'compositions/cta.html', required_content_fields: ['headline'], content: { headline: 'Ship it' }, asset_refs: [] },
    ],
    artifact_refs: [],
  })),
  compileVideoContentBriefToStoryboard: vi.fn(() => ({
    kind: 'video-storyboard',
    version: '1.0.0',
    format: { width: 1920, height: 1080 },
    beats: [],
  })),
  compileVideoStoryboardToNarratedVideoBrief: vi.fn(() => ({
    kind: 'narrated-video-brief',
    version: '1.0.0',
    script: { hook: 'hook', feature: 'feature', cta: 'cta' },
    narration: { artifact_ref: 'active/shared/exports/narration.aiff' },
    design_system: { brand_name: 'Kyberion' },
  })),
  renderNarratedFallbackVideo: vi.fn(async () => ({
    executed: true,
    backend: 'ffmpeg_fallback',
    output_path: '/tmp/video-composition/output.mp4',
  })),
  renderVideoCompositionBundleAsync: vi.fn(async () => ({
    executed: true,
    backend: 'hyperframes_cli',
    output_path: '/tmp/video-composition/output.mp4',
    artifact_refs: [
      '/tmp/video-composition/index.html',
      '/tmp/video-composition/render-plan.json',
      '/tmp/video-composition/output.mp4',
    ],
  })),
  writeVideoCompositionBundle: vi.fn(() => ({
    artifact_refs: [
      '/tmp/video-composition/index.html',
      '/tmp/video-composition/render-plan.json',
    ],
  })),
}));

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual('@agent/core') as any;
  return {
    ...actual,
    compileSchemaFromPath: mocks.compileSchemaFromPath,
    safeExec: mocks.safeExec,
    safeExistsSync: mocks.safeExistsSync,
    safeStat: mocks.safeStat,
    safeMkdir: mocks.safeMkdir,
    safeWriteFile: mocks.safeWriteFile,
    withRetry: mocks.withRetry,
    getVideoCompositionTemplateRegistry: mocks.getVideoCompositionTemplateRegistry,
    getVideoRenderRuntimePolicy: mocks.getVideoRenderRuntimePolicy,
    compileNarratedVideoBriefToCompositionADF: mocks.compileNarratedVideoBriefToCompositionADF,
    compileVideoCompositionADF: mocks.compileVideoCompositionADF,
    compileVideoContentBriefToStoryboard: mocks.compileVideoContentBriefToStoryboard,
    compileVideoStoryboardToNarratedVideoBrief: mocks.compileVideoStoryboardToNarratedVideoBrief,
    safeReadFile: mocks.safeReadFile,
    renderNarratedFallbackVideo: mocks.renderNarratedFallbackVideo,
    renderVideoCompositionBundleAsync: mocks.renderVideoCompositionBundleAsync,
    writeVideoCompositionBundle: mocks.writeVideoCompositionBundle,
  };
});

describe('video-composition-actuator', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { safeReadFile } = await import('@agent/core');
    vi.mocked(safeReadFile).mockImplementation((filePath: string) => {
      if (String(filePath).includes('manifest.json')) {
        return JSON.stringify({ recovery_policy: {} });
      }
      return '{}';
    });
    vi.mocked(mocks.safeExistsSync).mockImplementation(() => true);
    vi.mocked(mocks.safeWriteFile).mockImplementation(() => undefined);
    vi.mocked(mocks.safeMkdir).mockImplementation(() => undefined);
    vi.mocked(mocks.safeExec).mockImplementation((command: string, args: any[]) => {
      if (command === 'ffprobe' && Array.isArray(args) && args.includes('a:0')) {
        return '0';
      }
      if (command === 'ffprobe' && Array.isArray(args) && args.includes('v:0')) {
        return '1';
      }
      return '1';
    });
  });

  it('lists governed templates', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'list_video_composition_templates',
      params: {},
    } as any);

    expect(result).toEqual(expect.objectContaining({
      status: 'succeeded',
      default_template_id: 'basic-title-card',
    }));
  });

  it('compiles narrated video brief into composition adf', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'compile_narrated_video_brief',
      params: {
        narrated_video_brief: {
          kind: 'narrated-video-brief',
          version: '1.0.0',
        },
      },
    } as any);

    expect(mocks.compileNarratedVideoBriefToCompositionADF).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      status: 'succeeded',
      kind: 'compiled_video_composition_adf',
    }));
    expect(result.video_composition_adf.kind).toBe('video-composition-adf');
  });

  it('creates narrated intro movie in a single action', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'create_narrated_intro_movie',
      params: {
        narrated_video_brief: {
          kind: 'narrated-video-brief',
          version: '1.0.0',
          script: {
            hook: 'Intent to Execution',
            feature: 'Contracts connect planning and execution.',
            cta: 'Operate with Kyberion.',
          },
          narration: {
            artifact_ref: 'active/shared/exports/narration.aiff',
          },
          design_system: {
            brand_name: 'Kyberion',
          },
        },
      },
    } as any);

    expect(mocks.compileNarratedVideoBriefToCompositionADF).toHaveBeenCalled();
    expect(mocks.writeVideoCompositionBundle).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      kind: 'narrated_intro_movie_run',
    }));
    expect(result.execution).toEqual(expect.objectContaining({
      status: 'succeeded',
    }));
  });

  it('compiles video content brief into storyboard', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'compile_video_content_brief',
      params: {
        video_content_brief: {
          kind: 'video-content-brief',
          version: '1.0.0',
          audience: 'operators',
          objective: 'turn approved messaging into content',
          distribution_channel: 'docs-demo',
          content_type: 'howto',
          presentation_mode: 'howto',
          promise: 'clear process',
          desired_takeaway: 'content brief becomes a renderable plan',
          constraints: ['no pitch'],
          proof_points: ['brief', 'storyboard', 'render'],
          design_system_ref: {
            system_id: 'operator-ops',
            brand_name: 'Kyberion',
          },
        },
      },
    } as any);

    expect(mocks.compileVideoContentBriefToStoryboard).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      status: 'succeeded',
      kind: 'compiled_video_storyboard',
    }));
  });

  it('creates narrated movie from video content brief', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'create_narrated_video_from_content_brief',
      params: {
        video_content_brief: {
          kind: 'video-content-brief',
          version: '1.0.0',
          audience: 'operators',
          objective: 'turn approved messaging into content',
          distribution_channel: 'docs-demo',
          content_type: 'howto',
          presentation_mode: 'howto',
          promise: 'clear process',
          desired_takeaway: 'content brief becomes a renderable plan',
          constraints: ['no pitch'],
          proof_points: ['brief', 'storyboard', 'render'],
          design_system_ref: {
            system_id: 'operator-ops',
            brand_name: 'Kyberion',
            background_color: '#07111f',
          },
        },
        narration_artifact_ref: 'active/shared/exports/narration.aiff',
        output: {
          format: 'mp4',
          target_path: '/tmp/content-brief-movie.mp4',
          await_completion: true,
        },
      },
    } as any);

    expect(mocks.compileVideoContentBriefToStoryboard).toHaveBeenCalled();
    expect(mocks.compileVideoStoryboardToNarratedVideoBrief).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      kind: 'narrated_content_brief_movie_run',
    }));
    expect(result.execution).toEqual(expect.objectContaining({
      status: 'succeeded',
    }));
  });

  it('repairs invalid rendered output with fallback video', async () => {
    vi.mocked(mocks.getVideoRenderRuntimePolicy).mockImplementation(() => ({
      version: 'test',
      queue: { concurrency: 1, cancellation: 'queued_or_running' },
      progress: { throttle_ms: 0, min_percent_delta: 0, emit_heartbeat: true },
      bundle: { default_bundle_root: 'active/shared/tmp/video-composition', copy_declared_assets: false },
      render: { allowed_output_formats: ['mp4'], enable_backend_rendering: true, backend: 'hyperframes_cli', quality: 'standard', command_timeout_ms: 300000 },
    }));
    vi.mocked(mocks.safeExec).mockImplementation((command: string) => {
      if (command === 'ffprobe') {
        return '';
      }
      return '1';
    });
    vi.mocked(mocks.safeStat).mockReturnValue({ size: 128 } as any);

    try {
      const { handleAction } = await import('./index.js');
      const result = await handleAction({
        action: 'create_narrated_intro_movie',
        params: {
          narrated_video_brief: {
            kind: 'narrated-video-brief',
            version: '1.0.0',
            script: {
              hook: 'Intent to Execution',
              feature: 'Contracts connect planning and execution.',
              cta: 'Operate with Kyberion.',
            },
            narration: {
              artifact_ref: 'active/shared/exports/narration.aiff',
            },
            design_system: {
              brand_name: 'Kyberion',
            },
          },
        },
      } as any);

      expect(mocks.renderNarratedFallbackVideo).toHaveBeenCalled();
      expect(mocks.compileVideoCompositionADF).toHaveBeenCalled();
      expect(result.execution).toEqual(expect.objectContaining({
        status: 'succeeded',
      }));
    } finally {
      vi.mocked(mocks.getVideoRenderRuntimePolicy).mockImplementation(() => ({
        version: 'test',
        queue: { concurrency: 1, cancellation: 'queued_or_running' },
        progress: { throttle_ms: 0, min_percent_delta: 0, emit_heartbeat: true },
        bundle: { default_bundle_root: 'active/shared/tmp/video-composition', copy_declared_assets: false },
        render: { allowed_output_formats: ['mp4'], enable_backend_rendering: false, backend: 'none', quality: 'standard', command_timeout_ms: 300000 },
      }));
      vi.mocked(mocks.safeExec).mockImplementation((command: string, args: any[]) => {
        if (command === 'ffprobe' && Array.isArray(args) && args.includes('a:0')) {
          return '0';
        }
        if (command === 'ffprobe' && Array.isArray(args) && args.includes('v:0')) {
          return '1';
        }
        return '1';
      });
      vi.mocked(mocks.safeStat).mockReturnValue({ size: 4096 } as any);
    }
  });

  it('verifies rendered video artifacts with audio and video streams', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'verify_rendered_video_artifact',
      params: {
        path: '/tmp/content-brief-movie.mp4',
        require_audio: true,
        require_video: true,
      },
    } as any);

    expect(mocks.safeExec).toHaveBeenCalledWith(
      'ffprobe',
      expect.arrayContaining(['-select_streams', 'a:0']),
      expect.objectContaining({ timeoutMs: 30000 }),
    );
    expect(result).toEqual(expect.objectContaining({
      status: 'succeeded',
      kind: 'video_artifact_verification',
      has_audio: true,
      has_video: true,
    }));
  });

  it('prepares a composed-video bundle from an adf', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'prepare_video_composition',
      params: {
        video_composition_adf: {
          kind: 'video-composition-adf',
          version: '1.0.0',
          composition: {
            duration_sec: 3,
            fps: 30,
            width: 1920,
            height: 1080,
          },
          scenes: [
            {
              scene_id: 'hook',
              start_sec: 0,
              duration_sec: 3,
              template_ref: { template_id: 'basic-title-card' },
              content: { headline: 'Hello deterministic video' },
            },
          ],
          output: {
            format: 'mp4',
          },
        },
      },
    } as any);

    expect(mocks.writeVideoCompositionBundle).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      status: 'succeeded',
      output_format: 'mp4',
      artifact_refs: ['/tmp/video-composition/index.html', '/tmp/video-composition/render-plan.json'],
      backend_rendering_enabled: false,
    }));
    expect(result.diagnostics).toEqual(expect.objectContaining({
      terminal_status: 'completed',
    }));
    expect(typeof result.diagnostics.created_at).toBe('string');
    expect(typeof result.diagnostics.started_at).toBe('string');
    expect(typeof result.diagnostics.finished_at).toBe('string');
    expect(typeof result.diagnostics.duration_ms).toBe('number');
  });

  it('runs backend rendering when policy enables it', async () => {
    mocks.getVideoRenderRuntimePolicy.mockReturnValue({
      version: 'test',
      queue: { concurrency: 1, cancellation: 'queued_or_running' },
      progress: { throttle_ms: 0, min_percent_delta: 0, emit_heartbeat: true },
      bundle: { default_bundle_root: 'active/shared/tmp/video-composition', copy_declared_assets: false },
      render: { allowed_output_formats: ['mp4'], enable_backend_rendering: true, backend: 'hyperframes_cli', quality: 'standard', command_timeout_ms: 300000 },
    });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'prepare_video_composition',
      params: {
        video_composition_adf: {
          kind: 'video-composition-adf',
          version: '1.0.0',
          composition: {
            duration_sec: 3,
            fps: 30,
            width: 1920,
            height: 1080,
          },
          scenes: [
            {
              scene_id: 'hook',
              start_sec: 0,
              duration_sec: 3,
              template_ref: { template_id: 'basic-title-card' },
              content: { headline: 'Render this scene' },
            },
          ],
          output: {
            format: 'mp4',
            target_path: '/tmp/video-composition/output.mp4',
            await_completion: true,
          },
        },
      },
    } as any);

    expect(mocks.renderVideoCompositionBundleAsync).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      status: 'succeeded',
      backend_rendering_enabled: true,
      backend_render_backend: 'hyperframes_cli',
      backend_rendered: true,
    }));
    expect(result.artifact_refs).toContain('/tmp/video-composition/output.mp4');
  });

  it('supports async enqueue and status/queue inspection', async () => {
    const { handleAction } = await import('./index.js');
    const queued = await handleAction({
      action: 'prepare_video_composition',
      params: {
        video_composition_adf: {
          kind: 'video-composition-adf',
          version: '1.0.0',
          composition: {
            duration_sec: 3,
            fps: 30,
            width: 1920,
            height: 1080,
          },
          scenes: [
            {
              scene_id: 'hook',
              start_sec: 0,
              duration_sec: 3,
              template_ref: { template_id: 'basic-title-card' },
              content: { headline: 'queue me' },
            },
          ],
          output: {
            format: 'mp4',
            await_completion: false,
          },
        },
      },
    } as any);

    expect(queued).toEqual(expect.objectContaining({
      status: 'queued',
      await_completion: false,
      output_format: 'mp4',
      job_ticket_path: expect.stringContaining('/tmp/video-composition/job-state.json'),
    }));
    expect(typeof queued.job_id).toBe('string');
    expect(mocks.safeWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/video-composition/job-state.json'),
      expect.stringContaining(`"job_id": "${queued.job_id}"`),
    );

    const queue = await handleAction({
      action: 'get_video_composition_queue',
      params: {},
    } as any);
    expect(queue).toEqual(expect.objectContaining({
      status: 'succeeded',
    }));
    expect(queue.queue).toEqual(expect.objectContaining({
      concurrency: 1,
    }));

    const status = await handleAction({
      action: 'get_video_composition_job_status',
      params: { job_id: queued.job_id },
    } as any);
    expect(status).toEqual(expect.objectContaining({
      status: 'succeeded',
      job_id: queued.job_id,
    }));
    expect(status.packet).toEqual(expect.objectContaining({
      job_id: queued.job_id,
    }));
  });

  it('defaults to queued when backend rendering is enabled and await_completion is omitted', async () => {
    mocks.getVideoRenderRuntimePolicy.mockReturnValue({
      version: 'test',
      queue: { concurrency: 1, cancellation: 'queued_or_running' },
      progress: { throttle_ms: 0, min_percent_delta: 0, emit_heartbeat: true },
      bundle: { default_bundle_root: 'active/shared/tmp/video-composition', copy_declared_assets: false },
      render: { allowed_output_formats: ['mp4'], enable_backend_rendering: true, backend: 'hyperframes_cli', quality: 'standard', command_timeout_ms: 300000 },
    });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'prepare_video_composition',
      params: {
        video_composition_adf: {
          kind: 'video-composition-adf',
          version: '1.0.0',
          composition: {
            duration_sec: 3,
            fps: 30,
            width: 1920,
            height: 1080,
          },
          scenes: [
            {
              scene_id: 'hook',
              start_sec: 0,
              duration_sec: 3,
              template_ref: { template_id: 'basic-title-card' },
              content: { headline: 'queue by default' },
            },
          ],
          output: {
            format: 'mp4',
          },
        },
      },
    } as any);

    expect(result).toEqual(expect.objectContaining({
      status: 'queued',
      await_completion: false,
      backend_rendering_enabled: true,
      backend_render_backend: 'hyperframes_cli',
    }));
    expect(String(result.await_completion_reason)).toContain('default asynchronous mode');
  });

  it('returns not_found when cancelling unknown job', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'cancel_video_composition_job',
      params: { job_id: 'missing-job' },
    } as any);

    expect(result).toEqual({
      status: 'not_found',
      job_id: 'missing-job',
      cancellation: null,
      packet: null,
      diagnostics: null,
    });
  });

  it('returns timeout for await action when job does not finish in time', async () => {
    mocks.getVideoRenderRuntimePolicy.mockReturnValue({
      version: 'test',
      queue: { concurrency: 1, cancellation: 'queued_or_running' },
      progress: { throttle_ms: 0, min_percent_delta: 0, emit_heartbeat: true },
      bundle: { default_bundle_root: 'active/shared/tmp/video-composition', copy_declared_assets: false },
      render: { allowed_output_formats: ['mp4'], enable_backend_rendering: true, backend: 'hyperframes_cli', quality: 'standard', command_timeout_ms: 300000 },
    });
    mocks.renderVideoCompositionBundleAsync.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        executed: true,
        backend: 'hyperframes_cli',
        output_path: '/tmp/video-composition/output.mp4',
      };
    });

    const { handleAction } = await import('./index.js');
    const queued = await handleAction({
      action: 'prepare_video_composition',
      params: {
        video_composition_adf: {
          kind: 'video-composition-adf',
          version: '1.0.0',
          composition: {
            duration_sec: 3,
            fps: 30,
            width: 1920,
            height: 1080,
          },
          scenes: [
            {
              scene_id: 'hook',
              start_sec: 0,
              duration_sec: 3,
              template_ref: { template_id: 'basic-title-card' },
              content: { headline: 'await timeout' },
            },
          ],
          output: {
            format: 'mp4',
            await_completion: false,
          },
        },
      },
    } as any);

    const awaited = await handleAction({
      action: 'await_video_composition_job',
      params: {
        job_id: queued.job_id,
        timeout_ms: 20,
      },
    } as any);

    expect(awaited).toEqual(expect.objectContaining({
      status: 'timeout',
      job_id: queued.job_id,
    }));
  });

  it('cancels a running backend render job', async () => {
    mocks.getVideoRenderRuntimePolicy.mockReturnValue({
      version: 'test',
      queue: { concurrency: 1, cancellation: 'queued_or_running' },
      progress: { throttle_ms: 0, min_percent_delta: 0, emit_heartbeat: true },
      bundle: { default_bundle_root: 'active/shared/tmp/video-composition', copy_declared_assets: false },
      render: { allowed_output_formats: ['mp4'], enable_backend_rendering: true, backend: 'hyperframes_cli', quality: 'standard', command_timeout_ms: 300000 },
    });
    mocks.renderVideoCompositionBundleAsync.mockImplementationOnce(async (_plan: any, _policy: any, options: any) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 500) {
        if (options?.isCancelled?.()) {
          const error: any = new Error('video render cancelled');
          error.cancelled = true;
          error.timed_out = false;
          error.signal = 'SIGTERM';
          error.exit_code = null;
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return {
        executed: true,
        backend: 'hyperframes_cli',
        output_path: '/tmp/video-composition/output.mp4',
      };
    });

    const { handleAction } = await import('./index.js');
    const queued = await handleAction({
      action: 'prepare_video_composition',
      params: {
        video_composition_adf: {
          kind: 'video-composition-adf',
          version: '1.0.0',
          composition: {
            duration_sec: 3,
            fps: 30,
            width: 1920,
            height: 1080,
          },
          scenes: [
            {
              scene_id: 'hook',
              start_sec: 0,
              duration_sec: 3,
              template_ref: { template_id: 'basic-title-card' },
              content: { headline: 'cancel me' },
            },
          ],
          output: {
            format: 'mp4',
            await_completion: false,
          },
        },
      },
    } as any);

    await waitForPacketStatus(handleAction, queued.job_id, 'rendering');
    const cancelled = await handleAction({
      action: 'cancel_video_composition_job',
      params: { job_id: queued.job_id, reason: 'operator-requested stop' },
    } as any);
    expect(cancelled).toEqual(expect.objectContaining({
      status: 'succeeded',
      cancellation: 'running',
      job_id: queued.job_id,
    }));
    expect(cancelled.diagnostics).toEqual(expect.objectContaining({
      cancellation_reason: 'operator-requested stop',
    }));

    const status = await waitForCancelledStatusWithSignal(handleAction, queued.job_id);
    expect(status.packet.status).toBe('cancelled');
    expect(status.packet.message).toContain('operator-requested stop');
    expect(status.diagnostics).toEqual(expect.objectContaining({
      terminal_status: 'cancelled',
      cancellation_reason: 'operator-requested stop',
      backend_exit_signal: 'SIGTERM',
      backend_cancelled: true,
    }));
    expect(typeof status.diagnostics.duration_ms).toBe('number');
  });
});

async function waitForCancelledStatusWithSignal(handleAction: any, jobId: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const status = await handleAction({
      action: 'get_video_composition_job_status',
      params: { job_id: jobId },
    } as any);
    if (status?.packet?.status === 'cancelled' && status?.diagnostics?.backend_exit_signal) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for cancelled packet with signal: ${jobId}`);
}

async function waitForPacketStatus(handleAction: any, jobId: string, expectedStatus: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const status = await handleAction({
      action: 'get_video_composition_job_status',
      params: { job_id: jobId },
    } as any);
    if (status?.packet?.status === expectedStatus) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for packet status ${expectedStatus}: ${jobId}`);
}

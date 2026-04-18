import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  compileSchemaFromPath: vi.fn(() => {
    const validator: any = () => true;
    validator.errors = [];
    return validator;
  }),
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
  renderVideoCompositionBundleAsync: vi.fn(async () => ({
    executed: true,
    backend: 'hyperframes_cli',
    output_path: '/tmp/video-composition/output.mp4',
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
    getVideoCompositionTemplateRegistry: mocks.getVideoCompositionTemplateRegistry,
    getVideoRenderRuntimePolicy: mocks.getVideoRenderRuntimePolicy,
    safeReadFile: mocks.safeReadFile,
    renderVideoCompositionBundleAsync: mocks.renderVideoCompositionBundleAsync,
    writeVideoCompositionBundle: mocks.writeVideoCompositionBundle,
  };
});

describe('video-composition-actuator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    }));
    expect(typeof queued.job_id).toBe('string');

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
      cancellation_reason: 'operator-requested stop',
      backend_exit_signal: 'SIGTERM',
      backend_cancelled: true,
    }));
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

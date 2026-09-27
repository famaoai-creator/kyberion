import { describe, expect, it } from 'vitest';
import { VideoRenderRuntime } from './video-render-runtime.js';

describe('video render runtime', () => {
  it('runs queued jobs and emits completion packets', async () => {
    const runtime = new VideoRenderRuntime({
      version: 'test',
      queue: { concurrency: 1, cancellation: 'queued_or_running' },
      progress: { throttle_ms: 0, min_percent_delta: 0, emit_heartbeat: true },
      bundle: {
        default_bundle_root: 'active/shared/tmp/video-composition',
        copy_declared_assets: false,
      },
      render: {
        allowed_output_formats: ['mp4'],
        enable_backend_rendering: false,
        backend: 'none',
        quality: 'standard',
        command_timeout_ms: 300000,
      },
    });

    runtime.enqueue({
      jobId: 'job-1',
      async run(api) {
        api.report({
          status: 'assembling_bundle',
          progress: { current: 1, total: 2, percent: 50, unit: 'steps' },
          message: 'assembling',
        });
        return { artifactRefs: ['active/shared/tmp/video-composition/job-1/index.html'] };
      },
    });

    const finalPacket = await waitForPacket(
      runtime,
      'job-1',
      (packet) => packet.status === 'completed'
    );
    expect(finalPacket.status).toBe('completed');
    expect(finalPacket.artifact_refs).toEqual([
      'active/shared/tmp/video-composition/job-1/index.html',
    ]);
  });

  it('reports queue position changes for waiting jobs', async () => {
    const runtime = new VideoRenderRuntime({
      version: 'test',
      queue: { concurrency: 1, cancellation: 'queued_or_running' },
      progress: { throttle_ms: 0, min_percent_delta: 0, emit_heartbeat: true },
      bundle: {
        default_bundle_root: 'active/shared/tmp/video-composition',
        copy_declared_assets: false,
      },
      render: {
        allowed_output_formats: ['mp4'],
        enable_backend_rendering: false,
        backend: 'none',
        quality: 'standard',
        command_timeout_ms: 300000,
      },
    });

    let releaseFirstJob: (() => void) | null = null;
    runtime.enqueue({
      jobId: 'job-1',
      async run() {
        await new Promise<void>((resolve) => {
          releaseFirstJob = resolve;
        });
        return;
      },
    });

    runtime.enqueue({
      jobId: 'job-2',
      async run() {
        return;
      },
    });

    const queuedPacket = runtime.getPacket('job-2');
    expect(queuedPacket?.status).toBe('queued');
    expect(queuedPacket?.queue?.position).toBe(1);
    expect(queuedPacket?.queue?.queued_total).toBe(1);
    expect(queuedPacket?.queue?.running).toBe(1);

    expect(typeof releaseFirstJob).toBe('function');
    releaseFirstJob?.();
    const completed = await waitForPacket(
      runtime,
      'job-2',
      (packet) => packet.status === 'completed'
    );
    expect(completed.status).toBe('completed');
  });
});

async function waitForPacket(
  runtime: VideoRenderRuntime,
  jobId: string,
  predicate: (packet: NonNullable<ReturnType<VideoRenderRuntime['getPacket']>>) => boolean
) {
  const current = runtime.getPacket(jobId);
  if (current && predicate(current)) return current;

  return await new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    unsubscribe = runtime.subscribe((packet) => {
      if (packet.job_id !== jobId || !predicate(packet)) return;
      unsubscribe();
      resolve(packet);
    });
  });
}

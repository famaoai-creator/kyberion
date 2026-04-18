import { describe, expect, it } from 'vitest';
import { VideoRenderRuntime } from './video-render-runtime.js';

describe('video render runtime', () => {
  it('runs queued jobs and emits completion packets', async () => {
    const runtime = new VideoRenderRuntime({
      version: 'test',
      queue: { concurrency: 1, cancellation: 'queued_or_running' },
      progress: { throttle_ms: 0, min_percent_delta: 0, emit_heartbeat: true },
      bundle: { default_bundle_root: 'active/shared/tmp/video-composition', copy_declared_assets: false },
      render: { allowed_output_formats: ['mp4'], enable_backend_rendering: false },
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

    const finalPacket = await waitForPacket(runtime, 'job-1');
    expect(finalPacket.status).toBe('completed');
    expect(finalPacket.artifact_refs).toEqual(['active/shared/tmp/video-composition/job-1/index.html']);
  });
});

async function waitForPacket(runtime: VideoRenderRuntime, jobId: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const packet = runtime.getPacket(jobId);
    if (packet && ['completed', 'failed', 'cancelled'].includes(packet.status)) {
      return packet;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for packet: ${jobId}`);
}

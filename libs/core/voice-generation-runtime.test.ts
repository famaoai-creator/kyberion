import { describe, expect, it } from 'vitest';
import { VoiceGenerationRuntime } from './voice-generation-runtime.js';

describe('voice generation runtime', () => {
  it('executes queued jobs serially', async () => {
    const runtime = new VoiceGenerationRuntime({
      version: 'test',
      queue: { concurrency: 1, cancellation: 'queued_or_running' },
      chunking: {
        default_max_chunk_chars: 800,
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
    });

    const executionOrder: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    runtime.enqueue({
      jobId: 'job-1',
      async run(api) {
        executionOrder.push('job-1:start');
        api.report({
          status: 'generating',
          progress: { current: 1, total: 2, percent: 50, unit: 'chunks' },
        });
        await firstDone;
        executionOrder.push('job-1:end');
      },
    });

    runtime.enqueue({
      jobId: 'job-2',
      async run() {
        executionOrder.push('job-2:start');
        executionOrder.push('job-2:end');
      },
    });

    await waitFor(() => executionOrder.includes('job-1:start'));
    expect(executionOrder).toEqual(['job-1:start']);

    releaseFirst();

    await waitFor(() => runtime.getPacket('job-2')?.status === 'completed');
    expect(executionOrder).toEqual(['job-1:start', 'job-1:end', 'job-2:start', 'job-2:end']);
  });

  it('cancels queued jobs before execution', async () => {
    const runtime = new VoiceGenerationRuntime({
      version: 'test',
      queue: { concurrency: 1, cancellation: 'queued_or_running' },
      chunking: {
        default_max_chunk_chars: 800,
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
    });

    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    runtime.enqueue({
      jobId: 'job-1',
      async run() {
        await firstDone;
      },
    });
    runtime.enqueue({
      jobId: 'job-2',
      async run() {
        throw new Error('should not run');
      },
    });

    expect(runtime.cancel('job-2')).toBe('queued');
    releaseFirst();

    await waitFor(() => runtime.getPacket('job-1')?.status === 'completed');
    expect(runtime.getPacket('job-2')?.status).toBe('cancelled');
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

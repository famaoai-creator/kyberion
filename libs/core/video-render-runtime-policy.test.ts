import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver, safeMkdir, safeWriteFile } from '@agent/core';
import { getVideoRenderRuntimePolicy, resetVideoRenderRuntimePolicyCache } from './video-render-runtime-policy.js';

describe('video render runtime policy', () => {
  const tmpDir = pathResolver.sharedTmp('video-render-runtime-policy-tests');
  const overridePath = `${tmpDir}/video-render-runtime-policy.json`;

  afterEach(() => {
    delete process.env.KYBERION_VIDEO_RENDER_RUNTIME_POLICY_PATH;
    resetVideoRenderRuntimePolicyCache();
  });

  it('loads override policy files', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      overridePath,
      JSON.stringify({
        version: 'test',
        queue: { concurrency: 2, cancellation: 'queued_only' },
        progress: {
          throttle_ms: 100,
          min_percent_delta: 5,
          emit_heartbeat: false,
        },
        bundle: {
          default_bundle_root: 'active/shared/tmp/custom-video',
          copy_declared_assets: true,
        },
        render: {
          allowed_output_formats: ['mp4', 'webm'],
          enable_backend_rendering: true,
        },
      }),
    );
    process.env.KYBERION_VIDEO_RENDER_RUNTIME_POLICY_PATH = overridePath;

    const policy = getVideoRenderRuntimePolicy();
    expect(policy.version).toBe('test');
    expect(policy.queue.concurrency).toBe(2);
    expect(policy.render.enable_backend_rendering).toBe(true);
  });
});

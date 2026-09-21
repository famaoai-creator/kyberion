import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImageGenerationProvider } from '@agent/core/image-generation-types';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { registerSeamCalibrationAdapter, runSeamCalibration } from '@agent/core/seam-calibration';
import { createImageGenerationCalibrationAdapter } from './image-generation-provider.js';

const outRoot = pathResolver.sharedTmp(`image-calibration-test-${process.pid}`);

function fakeProvider(
  id: string,
  traits: Partial<ImageGenerationProvider>,
  writes = true
): ImageGenerationProvider {
  return {
    id,
    ...traits,
    isAvailable: async () => true,
    generate: vi.fn(async (request) => {
      if (!writes) return { status: 'failed' as const, provider: id, elapsedMs: 1, error: 'boom' };
      safeMkdir(path.dirname(request.targetPath!), { recursive: true });
      safeWriteFile(request.targetPath!, 'png-bytes');
      return { status: 'succeeded' as const, provider: id, path: request.targetPath, elapsedMs: 1 };
    }),
  };
}

describe('image-generation-provider calibration adapter', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    safeRmSync(outRoot, { recursive: true, force: true });
  });

  it('runs local providers, skips remote/paid ones unless listed, and reports artifacts', async () => {
    const local = fakeProvider('local_flux', {
      executionLocality: 'local',
      costTier: 'self_hosted',
    });
    const broken = fakeProvider('comfyui', { executionLocality: 'local' }, false);
    const cloud = fakeProvider('gemini_service', { executionLocality: 'remote', costTier: 'paid' });
    const providers = new Map([local, broken, cloud].map((p) => [p.id, p]));
    const listCandidates = vi.fn(async () => [
      { id: 'local_flux', eligible: true },
      { id: 'comfyui', eligible: true },
      { id: 'gemini_service', eligible: true },
      {
        id: 'cursor_host_bridge',
        eligible: false,
        unmet: ['interactive host hand-off not allowed'],
      },
    ]);
    const adapter = createImageGenerationCalibrationAdapter({
      listCandidates,
      getProvider: (id) => providers.get(id),
    });
    dispose = registerSeamCalibrationAdapter(adapter);

    const report = await runSeamCalibration({
      seam: 'image-generation-provider',
      input: { prompt: 'a lighthouse', aspect_ratio: '1:1' },
      outRoot,
      runId: 'image-test',
    });

    const byId = Object.fromEntries(report.providers.map((p) => [p.provider_id, p]));
    expect(byId.local_flux?.success_rate).toBe(1);
    const artifact = byId.local_flux?.runs[0]?.output?.artifact_path;
    expect(artifact).toBe(
      path.join(outRoot, 'image-generation-provider', 'image-test', 'local_flux', 'trial-1.png')
    );
    expect(byId.local_flux?.runs[0]?.metrics).toEqual({ bytes: 9 });
    expect(byId.comfyui?.runs[0]).toEqual(expect.objectContaining({ ok: false, error: 'boom' }));
    expect(byId.gemini_service?.skipped_reason).toMatch(/--providers/);
    expect(cloud.generate).not.toHaveBeenCalled();
    expect(byId.cursor_host_bridge?.eligible).toBe(false);
    expect(local.generate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'a lighthouse', aspectRatio: '1:1', awaitCompletion: true })
    );

    await runSeamCalibration({
      seam: 'image-generation-provider',
      input: { prompt: 'a lighthouse' },
      providers: ['gemini_service'],
      outRoot,
      runId: 'image-opt-in',
    });
    expect(cloud.generate).toHaveBeenCalledTimes(1);
  });

  it('rejects input without a prompt', async () => {
    const adapter = createImageGenerationCalibrationAdapter({
      listCandidates: async () => [],
      getProvider: () => undefined,
    });
    await expect(adapter.listCandidates({ prompt: ' ' })).rejects.toThrow(/needs a prompt/);
  });
});

import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { registerSeamCalibrationAdapter, runSeamCalibration } from '@agent/core/seam-calibration';
import { createVideoGenerationCalibrationAdapter } from './video-generation-provider.js';

const outRoot = pathResolver.sharedTmp(`video-calibration-test-${process.pid}`);

describe('video-generation-provider calibration adapter', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    safeRmSync(outRoot, { recursive: true, force: true });
  });

  it('skips billed API backends unless listed and generates through the actuator path', async () => {
    const generate = vi.fn(async (params: Record<string, unknown>) => {
      const target = String(params.target_path);
      safeMkdir(path.dirname(target), { recursive: true });
      safeWriteFile(target, 'mp4-bytes');
      return { status: 'succeeded', output_path: target, backend_id: params.backend_id };
    });
    dispose = registerSeamCalibrationAdapter(
      createVideoGenerationCalibrationAdapter({
        listCandidates: async () => [
          { id: 'media-generation.openai.sora-2', eligible: true },
          { id: 'media-generation.google.veo-3.1', eligible: true },
          {
            id: 'media-generation.comfyui.video',
            eligible: false,
            unmet: ['needs params.workflow, workflow_path or video_adf (ComfyUI runs workflows)'],
          },
        ],
        generate,
        requiresExplicitOptIn: (id) => id !== 'media-generation.comfyui.video',
      })
    );

    const unattended = await runSeamCalibration({
      seam: 'video-generation-provider',
      input: { prompt: 'a harbour at dawn', aspect_ratio: '16:9' },
      outRoot,
      runId: 'video-default',
    });
    expect(generate).not.toHaveBeenCalled();
    expect(unattended.providers.every((p) => p.runs.length === 0)).toBe(true);

    const optedIn = await runSeamCalibration({
      seam: 'video-generation-provider',
      input: { prompt: 'a harbour at dawn', aspect_ratio: '16:9' },
      providers: ['media-generation.openai.sora-2'],
      outRoot,
      runId: 'video-opt-in',
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'a harbour at dawn',
        aspect_ratio: '16:9',
        backend_id: 'media-generation.openai.sora-2',
        await_completion: true,
      })
    );
    const sora = optedIn.providers.find((p) => p.provider_id === 'media-generation.openai.sora-2');
    expect(sora?.runs[0]).toEqual(
      expect.objectContaining({
        ok: true,
        output: {
          artifact_path: path.join(
            outRoot,
            'video-generation-provider',
            'video-opt-in',
            'media-generation.openai.sora-2',
            'trial-1.mp4'
          ),
        },
      })
    );
  });

  it('reports a failed generation with its message', async () => {
    const adapter = createVideoGenerationCalibrationAdapter({
      listCandidates: async () => [],
      generate: async () => ({ status: 'failed', message: 'credential missing' }),
      requiresExplicitOptIn: () => true,
    });
    const result = await adapter.runTrial(
      'media-generation.runway.gen4.5',
      { prompt: 'x' },
      { outDir: outRoot, repeat: 0 }
    );
    expect(result).toEqual({ ok: false, error: 'credential missing' });
  });

  it('marks API backends as opt-in and the local ComfyUI workflow backend as not', () => {
    const adapter = createVideoGenerationCalibrationAdapter();
    expect(adapter.requiresExplicitOptIn?.('media-generation.google.veo-3.1')).toBe(true);
    expect(adapter.requiresExplicitOptIn?.('media-generation.openai.sora-2')).toBe(true);
    expect(adapter.requiresExplicitOptIn?.('media-generation.comfyui.video')).toBe(false);
  });
});

import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MusicGenerationProvider } from '@agent/core/music-generation-types';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { registerSeamCalibrationAdapter, runSeamCalibration } from '@agent/core/seam-calibration';
import { createMusicGenerationCalibrationAdapter } from './music-generation-provider.js';

const outRoot = pathResolver.sharedTmp(`music-calibration-test-${process.pid}`);

function fakeProvider(id: string): MusicGenerationProvider {
  return {
    id,
    costTier: 'self_hosted',
    executionLocality: 'local',
    isAvailable: async () => true,
    generate: vi.fn(async (request) => {
      safeMkdir(path.dirname(request.targetPath!), { recursive: true });
      safeWriteFile(request.targetPath!, 'wav');
      return { status: 'succeeded' as const, provider: id, path: request.targetPath, elapsedMs: 1 };
    }),
  };
}

describe('music-generation-provider calibration adapter', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    safeRmSync(outRoot, { recursive: true, force: true });
  });

  it('runs every eligible local provider on the same prompt and duration', async () => {
    const musicgen = fakeProvider('musicgen_mlx');
    const stable = fakeProvider('stable_audio_3');
    const providers = new Map([musicgen, stable].map((p) => [p.id, p]));
    const listCandidates = vi.fn(async () => [
      { id: 'musicgen_mlx', eligible: false, unmet: ['duration 60s exceeds max 30s'] },
      { id: 'stable_audio_3', eligible: true },
    ]);
    dispose = registerSeamCalibrationAdapter(
      createMusicGenerationCalibrationAdapter({
        listCandidates,
        getProvider: (id) => providers.get(id),
      })
    );

    const report = await runSeamCalibration({
      seam: 'music-generation-provider',
      input: { prompt: 'calm piano', duration_sec: 60 },
      outRoot,
      runId: 'music-test',
      repeats: 2,
    });

    expect(listCandidates).toHaveBeenCalledWith({ prompt: 'calm piano', duration_sec: 60 });
    expect(musicgen.generate).not.toHaveBeenCalled();
    expect(stable.generate).toHaveBeenCalledTimes(2);
    expect(stable.generate).toHaveBeenLastCalledWith(
      expect.objectContaining({ prompt: 'calm piano', durationSec: 60 })
    );
    const summary = report.providers.find((p) => p.provider_id === 'stable_audio_3');
    expect(summary?.runs.map((run) => run.output?.artifact_path)).toEqual([
      pathResolver.toRepoRelative(
        path.join(
          outRoot,
          'music-generation-provider',
          'music-test',
          'stable_audio_3',
          'trial-1.wav'
        )
      ),
      pathResolver.toRepoRelative(
        path.join(
          outRoot,
          'music-generation-provider',
          'music-test',
          'stable_audio_3',
          'trial-2.wav'
        )
      ),
    ]);
  });

  it('only runs remote or unknown providers when opted in', () => {
    const remote: MusicGenerationProvider = {
      ...fakeProvider('cloud_music'),
      executionLocality: 'remote',
    };
    const adapter = createMusicGenerationCalibrationAdapter({
      listCandidates: async () => [],
      getProvider: (id) =>
        id === 'cloud_music' ? remote : id === 'stable_audio_3' ? fakeProvider(id) : undefined,
    });
    expect(adapter.requiresExplicitOptIn?.('stable_audio_3')).toBe(false);
    expect(adapter.requiresExplicitOptIn?.('cloud_music')).toBe(true);
    expect(adapter.requiresExplicitOptIn?.('nope')).toBe(true);
  });
});

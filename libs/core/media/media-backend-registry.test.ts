import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getMediaBackendRecord,
  getMediaBackendRegistry,
  resolveImageBackend,
  resolveMediaBackendForPlatform,
  resolveMusicBackend,
  resolveVideoBackend,
  resolveVoiceBackend,
  probeMediaBackendAvailability,
  resetMediaBackendAvailabilityCache,
  resetMediaBackendRegistryCache,
  _resetMediaBackendAvailabilityCacheForTests,
  resolveMediaBackendWithAvailability,
} from './media-backend-registry.js';

describe('media backend registry', () => {
  beforeEach(() => {
    _resetMediaBackendAvailabilityCacheForTests();
    delete process.env.KYBERION_RUNWAY_API_KEY;
    delete process.env.RUNWAYML_API_SECRET;
    delete process.env.KYBERION_MEDIA_BACKEND_REGISTRY_PATH;
  });

  afterEach(() => {
    delete process.env.KYBERION_MEDIA_BACKEND_REGISTRY_PATH;
    resetMediaBackendRegistryCache();
  });

  it('caches availability probes and exposes bounded probe metadata', async () => {
    const first = await probeMediaBackendAvailability('video.hyperframes_cli', 'video', 'linux', {
      ttl_ms: 1_000,
    });
    const second = await probeMediaBackendAvailability('video.hyperframes_cli', 'video', 'linux', {
      ttl_ms: 1_000,
    });

    expect(first.cache_hit).toBe(false);
    expect(second.cache_hit).toBe(true);
    expect(second.probe_id).toBe(first.probe_id);
    expect(new Date(second.cache_expires_at).getTime()).toBeGreaterThan(
      new Date(second.probed_at).getTime()
    );
  });

  it('retains public cache reset APIs for consumers', () => {
    expect(resetMediaBackendAvailabilityCache).toEqual(expect.any(Function));
    expect(resetMediaBackendRegistryCache).toEqual(expect.any(Function));
    resetMediaBackendAvailabilityCache();
    resetMediaBackendRegistryCache();
    expect(getMediaBackendRegistry().default_backend_ids.image).toBe('media-generation.comfyui');
  });

  it('force bypasses the availability probe cache', async () => {
    const first = await probeMediaBackendAvailability('video.hyperframes_cli', 'video', 'linux', {
      ttl_ms: 1_000,
    });
    const forced = await probeMediaBackendAvailability('video.hyperframes_cli', 'video', 'linux', {
      force: true,
      ttl_ms: 1_000,
    });

    expect(forced.cache_hit).toBe(false);
    expect(forced.probe_id).not.toBe(first.probe_id);
  });

  it('deduplicates concurrent availability probes', async () => {
    const [first, second] = await Promise.all([
      probeMediaBackendAvailability('video.hyperframes_cli', 'video', 'linux', {
        ttl_ms: 1_000,
      }),
      probeMediaBackendAvailability('video.hyperframes_cli', 'video', 'linux', {
        ttl_ms: 1_000,
      }),
    ]);

    expect(second.probe_id).toBe(first.probe_id);
    expect(first.cache_hit).toBe(false);
    expect(second.cache_hit).toBe(false);
  });

  it('loads the governed registry and resolves defaults', () => {
    const registry = getMediaBackendRegistry();
    expect(registry.default_backend_ids.image).toBe('media-generation.comfyui');
    expect(registry.default_backend_ids.voice).toBe('voice.local_say');
    expect(registry.default_backend_ids.video).toBe('video.hyperframes_cli');
    expect(
      registry.backends.some((backend) => backend.backend_id === 'media-generation.local_flux')
    ).toBe(true);
    expect(
      registry.backends.some((backend) => backend.backend_id === 'media-generation.musicgen_mlx')
    ).toBe(true);
    expect(
      registry.backends.some(
        (backend) => backend.backend_id === 'media-generation.stable_audio_3_small_music'
      )
    ).toBe(true);
    expect(
      registry.backends.some(
        (backend) => backend.backend_id === 'media-generation.apple_playground'
      )
    ).toBe(true);
  });

  it('fails closed for an external registry override', () => {
    process.env.KYBERION_MEDIA_BACKEND_REGISTRY_PATH =
      '/tmp/kyberion-media-backend-registry-external.json';
    resetMediaBackendRegistryCache();

    expect(() => getMediaBackendRegistry()).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('resolves image, voice, and video backends through the same abstraction', () => {
    expect(resolveImageBackend().backend_id).toBe('media-generation.comfyui');
    expect(resolveImageBackend('local_flux', 'darwin').backend_id).toBe(
      'media-generation.local_flux'
    );
    expect(resolveImageBackend('apple_playground', 'darwin').backend_id).toBe(
      'media-generation.apple_playground'
    );
    expect(resolveVoiceBackend().backend_id).toBe('voice.local_say');
    expect(resolveVideoBackend().backend_id).toBe('video.hyperframes_cli');
    expect(resolveMusicBackend().backend_id).toBe('media-generation.comfyui.music');
    // musicgen_mlx is MLX-gated: inject Apple Silicon accelerators so the
    // assertion is hermetic on non-Mac hosts (linux CI has no mlx).
    expect(
      resolveMediaBackendForPlatform('music', 'media-generation.musicgen_mlx', 'darwin', 32, [
        'cpu',
        'mps',
        'mlx',
      ]).backend_id
    ).toBe('media-generation.musicgen_mlx');
    expect(resolveMusicBackend('stable_audio_3_small_music', 'darwin').backend_id).toBe(
      'media-generation.stable_audio_3_small_music'
    );
  });

  it('skips backends above the host memory budget via min_memory_gb', () => {
    // fp8 i2v fits a 16GB host; fp16 needs 24GB
    expect(
      resolveMediaBackendForPlatform('video', 'media-generation.comfyui.ltx-i2v', 'darwin', 16, [
        'mps',
      ]).backend_id
    ).toBe('media-generation.comfyui.ltx-i2v-fp8');
    expect(
      resolveMediaBackendForPlatform(
        'video',
        'media-generation.comfyui.ltx-i2v-fp8',
        'darwin',
        16,
        ['mps']
      ).backend_id
    ).toBe('media-generation.comfyui.ltx-i2v-fp8');
    // low-memory host with no fitting backend falls through to the default
    expect(
      resolveMediaBackendForPlatform('video', 'media-generation.comfyui.ltx-i2v', 'darwin', 8, [
        'mps',
      ]).backend_id
    ).toBe('video.hyperframes_cli');
  });

  it('skips backends the host accelerator cannot run via accelerators', () => {
    // CPU-only host cannot run the torch i2v backends -> default fallback
    expect(
      resolveMediaBackendForPlatform('video', 'media-generation.comfyui.ltx-i2v-fp8', 'linux', 32, [
        'cpu',
      ]).backend_id
    ).toBe('video.hyperframes_cli');
    // CUDA host can run fp8 i2v
    expect(
      resolveMediaBackendForPlatform('video', 'media-generation.comfyui.ltx-i2v-fp8', 'linux', 32, [
        'cpu',
        'cuda',
      ]).backend_id
    ).toBe('media-generation.comfyui.ltx-i2v-fp8');
    // MLX-only music backend resolves on Apple Silicon, falls back elsewhere
    expect(
      resolveMediaBackendForPlatform('music', 'media-generation.musicgen_mlx', 'darwin', 32, [
        'cpu',
        'mps',
        'mlx',
      ]).backend_id
    ).toBe('media-generation.musicgen_mlx');
    expect(
      resolveMediaBackendForPlatform('music', 'media-generation.musicgen_mlx', 'linux', 32, [
        'cpu',
        'cuda',
      ]).backend_id
    ).toBe('media-generation.comfyui.music');
  });

  it('does not return an exact backend record from a different modality', () => {
    expect(getMediaBackendRecord('media-generation.comfyui.video', 'image').modality).toBe('image');
    expect(getMediaBackendRecord('media-generation.comfyui', 'video')).toEqual(
      expect.objectContaining({
        backend_id: 'media-generation.comfyui.video',
        modality: 'video',
      })
    );
    expect(getMediaBackendRecord('media-generation.comfyui', 'music')).toEqual(
      expect.objectContaining({
        backend_id: 'media-generation.comfyui.music',
        modality: 'music',
      })
    );
  });

  it('maps the voice engine registry into normalized backend metadata', () => {
    const backend = getMediaBackendRecord('voice.local_say', 'voice');
    expect(backend.modality).toBe('voice');
    expect(backend.kind).toBe('local');
    expect(backend.provider).toBe('system_tts');
  });

  it('uses a shared platform probe contract before live runtime probes', async () => {
    const availability = await probeMediaBackendAvailability(
      'media-generation.apple_playground',
      'image',
      'linux'
    );
    expect(availability).toEqual(
      expect.objectContaining({
        backend_id: 'media-generation.apple_playground',
        modality: 'image',
        available: false,
        probe_kind: 'registry',
      })
    );
  });

  it('returns normalized availability metadata without changing modality', async () => {
    const resolution = await resolveMediaBackendWithAvailability(
      'video',
      'video.hyperframes_cli',
      'linux'
    );
    expect(resolution.backend.modality).toBe('video');
    expect(resolution.backend.backend_id).toBe('video.hyperframes_cli');
    expect(resolution.availability.probe_kind).toBe('registry');
    expect(resolution.fallback_used).toBe(false);
  });

  it('reports explicit API backends unavailable until a provider credential is configured', async () => {
    const missing = await probeMediaBackendAvailability(
      'media-generation.runway.gen4.5',
      'video',
      'linux',
      { force: true }
    );
    expect(missing).toEqual(
      expect.objectContaining({
        available: false,
        reason: expect.stringContaining('KYBERION_RUNWAY_API_KEY'),
      })
    );

    process.env.KYBERION_RUNWAY_API_KEY = 'test-key';
    const configured = await probeMediaBackendAvailability(
      'media-generation.runway.gen4.5',
      'video',
      'linux',
      { force: true }
    );
    expect(configured).toEqual(expect.objectContaining({ available: true }));
  });
});

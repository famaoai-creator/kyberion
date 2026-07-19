import { beforeEach, describe, expect, it } from 'vitest';
import {
  getMediaBackendRecord,
  getMediaBackendRegistry,
  resolveImageBackend,
  resolveMusicBackend,
  resolveVideoBackend,
  resolveVoiceBackend,
  probeMediaBackendAvailability,
  resetMediaBackendAvailabilityCache,
  resolveMediaBackendWithAvailability,
} from './media-backend-registry.js';

describe('media backend registry', () => {
  beforeEach(() => {
    resetMediaBackendAvailabilityCache();
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
      registry.backends.some(
        (backend) => backend.backend_id === 'media-generation.apple_playground'
      )
    ).toBe(true);
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
});

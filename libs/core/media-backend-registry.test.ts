import { describe, expect, it } from 'vitest';
import {
  getMediaBackendRecord,
  getMediaBackendRegistry,
  resolveImageBackend,
  resolveVideoBackend,
  resolveVoiceBackend,
} from './media-backend-registry.js';

describe('media backend registry', () => {
  it('loads the governed registry and resolves defaults', () => {
    const registry = getMediaBackendRegistry();
    expect(registry.default_backend_ids.image).toBe('media-generation.comfyui');
    expect(registry.default_backend_ids.voice).toBe('voice.local_say');
    expect(registry.default_backend_ids.video).toBe('video.hyperframes_cli');
    expect(registry.backends.some((backend) => backend.backend_id === 'media-generation.local_flux')).toBe(true);
  });

  it('resolves image, voice, and video backends through the same abstraction', () => {
    expect(resolveImageBackend().backend_id).toBe('media-generation.comfyui');
    expect(resolveImageBackend('local_flux', 'darwin').backend_id).toBe('media-generation.local_flux');
    expect(resolveVoiceBackend().backend_id).toBe('voice.local_say');
    expect(resolveVideoBackend().backend_id).toBe('video.hyperframes_cli');
  });

  it('maps the voice engine registry into normalized backend metadata', () => {
    const backend = getMediaBackendRecord('voice.local_say', 'voice');
    expect(backend.modality).toBe('voice');
    expect(backend.kind).toBe('local');
    expect(backend.provider).toBe('system_tts');
  });
});

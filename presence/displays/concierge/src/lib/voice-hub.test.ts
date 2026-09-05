import { afterEach, describe, expect, it, vi } from 'vitest';
import { voiceHubUrl } from './voice-hub.js';

describe('voiceHubUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers the explicitly configured URL over the port fallback', () => {
    vi.stubEnv('VOICE_HUB_URL', 'http://127.0.0.1:3999');
    vi.stubEnv('VOICE_HUB_PORT', '4999');

    expect(voiceHubUrl()).toBe('http://127.0.0.1:3999');
  });

  it('uses the configured port when the URL is absent', () => {
    vi.stubEnv('VOICE_HUB_URL', '');
    vi.stubEnv('VOICE_HUB_PORT', '4999');

    expect(voiceHubUrl()).toBe('http://127.0.0.1:4999');
  });
});

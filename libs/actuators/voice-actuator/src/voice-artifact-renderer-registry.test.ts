import { describe, expect, it } from 'vitest';
import { listVoiceArtifactRendererIds } from './voice-runtime-helpers.js';

describe('voice artifact renderer registry', () => {
  it('registers TTS adapters by id (speech_cpp, python_bridge, native_tts)', () => {
    expect(listVoiceArtifactRendererIds()).toEqual(['native_tts', 'python_bridge', 'speech_cpp']);
  });
});

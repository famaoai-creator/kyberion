import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  GeminiStreamingTextToSpeechBridge,
  StubStreamingTextToSpeechBridge,
  getStreamingTtsBridge,
  registerStreamingTtsBridge,
  resetStreamingTtsBridges,
} from './streaming-tts-bridge.js';

const mocks = vi.hoisted(() => ({
  executeServicePreset: vi.fn(),
}));

vi.mock('./service-engine.js', () => ({
  executeServicePreset: mocks.executeServicePreset,
}));

describe('GeminiStreamingTextToSpeechBridge', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    mocks.executeServicePreset.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetStreamingTtsBridges();
  });

  it('decodes Gemini TTS audio bytes into a PCM chunk', async () => {
    process.env.GEMINI_API_KEY = 'mock-gemini-key';
    mocks.executeServicePreset.mockResolvedValue({
      audioData: Buffer.from('pcm-audio', 'utf8').toString('base64'),
    });

    const bridge = new GeminiStreamingTextToSpeechBridge({ voice: 'Kore' });
    const chunks = bridge.synthesizeStream(
      (async function* () {
        yield 'Hello ';
        yield 'world';
      })(),
      'voice-profile'
    );

    const yielded = [];
    for await (const chunk of chunks) yielded.push(chunk);

    expect(yielded).toHaveLength(1);
    expect(Buffer.from(yielded[0].payload).toString('utf8')).toBe('pcm-audio');
    expect(yielded[0].format.sample_rate_hz).toBe(24000);
    expect(mocks.executeServicePreset).toHaveBeenCalledWith(
      'gemini',
      'generate_tts',
      expect.objectContaining({
        text: 'Hello world',
        voice: 'Kore',
      }),
      'secret-guard'
    );
  });

  it('resolves gemini bridge from the built-in registry shortcut', () => {
    expect(getStreamingTtsBridge('gemini').bridge_id).toBe('gemini');
  });

  it('rejects duplicate named providers and supports disposal', () => {
    const first = registerStreamingTtsBridge('test', () => new StubStreamingTextToSpeechBridge());
    expect(() =>
      registerStreamingTtsBridge('test', () => new StubStreamingTextToSpeechBridge())
    ).toThrow(/already registered/);
    expect(getStreamingTtsBridge('test').bridge_id).toBe('stub');
    first();
    expect(() => getStreamingTtsBridge('test')).toThrow(/unknown bridge id/);
  });
});

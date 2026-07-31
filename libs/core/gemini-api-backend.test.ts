import { describe, expect, it, vi } from 'vitest';
import {
  buildGeminiApiBackendFromEnv,
  GeminiApiBackend,
  GEMINI_API_DEFAULT_MODEL,
} from './gemini-api-backend.js';

describe('GeminiApiBackend', () => {
  it('builds from a Google AI Studio key without exposing the key in the model route', () => {
    const backend = buildGeminiApiBackendFromEnv({ GEMINI_API_KEY: 'test-gemini-key' });

    expect(backend).toBeInstanceOf(GeminiApiBackend);
    expect(backend?.getModel()).toBe(GEMINI_API_DEFAULT_MODEL);
    expect(backend?.name).toBe('gemini-api');
    expect(backend?.egressEndpoint).toBe('https://generativelanguage.googleapis.com/v1beta');
  });

  it('sends the native generateContent shape with X-Goog-Api-Key', async () => {
    const request = vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'AI is pattern learning.' }] } }],
    });
    const backend = new GeminiApiBackend({
      apiKey: 'test-gemini-key',
      model: 'gemini-flash-latest',
      request,
    });

    await expect(backend.prompt('Explain AI in a few words')).resolves.toBe(
      'AI is pattern learning.'
    );
    expect(request).toHaveBeenCalledOnce();
    const call = request.mock.calls[0][0] as {
      url: string;
      headers: Record<string, string>;
      data: { contents: Array<{ parts: Array<{ text: string }> }> };
      authenticateRequest: boolean;
    };
    expect(call.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent'
    );
    expect(call.headers['x-goog-api-key']).toBe('test-gemini-key');
    expect(call.data.contents[0].parts[0].text).toBe('Explain AI in a few words');
    expect(call.authenticateRequest).toBe(true);
  });

  it('accepts GOOGLE_API_KEY as the compatibility fallback', () => {
    const backend = buildGeminiApiBackendFromEnv({
      GOOGLE_API_KEY: 'test-google-key',
      KYBERION_GEMINI_MODEL: 'gemini-2.5-flash',
    });

    expect(backend?.getModel()).toBe('gemini-2.5-flash');
  });
});

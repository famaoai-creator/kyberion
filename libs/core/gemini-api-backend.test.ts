import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildGeminiApiBackendFromEnv,
  GeminiApiBackend,
  GEMINI_API_DEFAULT_MODEL,
} from './gemini-api-backend.js';

describe('GeminiApiBackend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it('sends Gemini function declarations and maps function calls', async () => {
    const request = vi.fn().mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: 'read_file', args: { path: 'README.md' } } }],
          },
        },
      ],
    });
    const backend = new GeminiApiBackend({
      apiKey: 'test-gemini-key',
      model: 'gemini-flash-latest',
      request,
    });

    const result = await backend.generateWithTools('Read the README', [
      {
        name: 'read_file',
        description: 'Read a workspace file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ]);

    expect(result.toolCalls).toEqual([{ name: 'read_file', input: { path: 'README.md' } }]);
    const body = request.mock.calls[0][0].data as {
      tools: Array<{ functionDeclarations: Array<{ name: string; parameters: unknown }> }>;
      toolConfig: { functionCallingConfig: { mode: string } };
    };
    expect(body.tools[0].functionDeclarations[0].name).toBe('read_file');
    expect(body.tools[0].functionDeclarations[0].parameters).toMatchObject({ type: 'object' });
    expect(body.toolConfig.functionCallingConfig.mode).toBe('AUTO');
  });

  it('translates the governed stop parameter to native generationConfig', async () => {
    const request = vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'done' }] } }],
    });
    const backend = new GeminiApiBackend({
      apiKey: 'test-gemini-key',
      model: 'gemini-3.6-flash',
      samplingParams: { stop: ['END'] },
      request,
    });

    await backend.prompt('Respond briefly');

    expect(request.mock.calls[0][0].data.generationConfig).toEqual({
      stopSequences: ['END'],
    });
  });

  it('inlines validated image attachments for vision prompts', async () => {
    const request = vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'A Kyberion mark.' }] } }],
    });
    const backend = new GeminiApiBackend({
      apiKey: 'test-gemini-key',
      model: 'gemini-flash-latest',
      request,
    });

    await expect(
      backend.promptWithImages('What is shown?', [
        { path: 'docs/assets/kyberion-social-preview.png', media_type: 'image/png' },
      ])
    ).resolves.toBe('A Kyberion mark.');

    const body = request.mock.calls[0][0].data as {
      contents: Array<{ parts: Array<{ inlineData?: { mimeType: string; data: string } }> }>;
    };
    expect(body.contents[0].parts[0].inlineData?.mimeType).toBe('image/png');
    expect(body.contents[0].parts[0].inlineData?.data.length).toBeGreaterThan(100);
  });

  it('streams SSE text deltas from streamGenerateContent', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"最初の"}]}}]}\n\n')
        );
        controller.enqueue(
          encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"応答です。"}]}}]}\n\n')
        );
        controller.close();
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      );
    vi.stubGlobal('fetch', fetchMock);
    const backend = new GeminiApiBackend({
      apiKey: 'test-gemini-key',
      model: 'gemini-flash-latest',
    });

    const deltas: string[] = [];
    for await (const delta of backend.streamPrompt('Tell me a short answer')) deltas.push(delta);

    expect(deltas).toEqual(['最初の', '応答です。']);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/models/gemini-flash-latest:streamGenerateContent?alt=sse'
    );
  });
});

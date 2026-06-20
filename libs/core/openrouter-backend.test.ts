import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterBackend, buildOpenRouterBackendFromEnv } from './openrouter-backend.js';

vi.mock('./secure-io.js', () => ({
  safeExec: vi.fn(() => 'shell-ok'),
  safeReadFile: vi.fn(() => 'file contents'),
  safeReaddir: vi.fn(() => ['a.txt', 'b.txt']),
  safeWriteFile: vi.fn(),
}));

describe('openrouter-backend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.KYBERION_OPENROUTER_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.KYBERION_OPENROUTER_MODEL;
    delete process.env.KYBERION_OPENROUTER_URL;
  });

  it('builds from env when an OpenRouter API key is configured', () => {
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    process.env.KYBERION_OPENROUTER_MODEL = 'meta-llama/llama-3-70b-instruct';

    const backend = buildOpenRouterBackendFromEnv();
    expect(backend?.name).toBe('openrouter');
  });

  it('sends OpenRouter headers and redacts prompt context', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'done',
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    vi.stubGlobal('fetch', fetchMock);

    const backend = new OpenRouterBackend({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'or-test-key',
      model: 'meta-llama/llama-3-70b-instruct',
      timeoutMs: 1_000,
    });

    const result = await backend.prompt('Say hello', {
      token: 'top-secret-token',
      nested: {
        apiKey: 'or-secret-key',
      },
    });

    expect(result).toBe('done');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect((request.headers as Record<string, string>).authorization).toBe('Bearer or-test-key');
    expect((request.headers as Record<string, string>)['HTTP-Referer']).toContain('kyberion');
    expect((request.headers as Record<string, string>)['X-Title']).toBe('Kyberion');
    expect(String(request.body)).not.toContain('top-secret-token');
    expect(String(request.body)).not.toContain('or-secret-key');
  });
});

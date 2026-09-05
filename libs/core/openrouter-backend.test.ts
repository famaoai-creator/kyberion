import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  OpenRouterBackend,
  buildOpenRouterBackendFromEnv,
  probeOpenRouterBackendAvailability,
} from './openrouter-backend.js';

vi.mock('./secure-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secure-io.js')>();
  return {
    ...actual,
    safeExec: vi.fn(() => 'shell-ok'),
    safeReadFile: vi.fn((filePath: string, options?: Parameters<typeof actual.safeReadFile>[1]) => {
      if (filePath.includes('reasoning-backend-policy.json'))
        return actual.safeReadFile(filePath, options);
      return 'file contents';
    }),
    safeReaddir: vi.fn(() => ['a.txt', 'b.txt']),
    safeWriteFile: vi.fn(),
  };
});

describe('openrouter-backend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.KYBERION_OPENROUTER_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.KYBERION_OPENROUTER_MODEL;
    delete process.env.KYBERION_OPENROUTER_PROFILE;
    delete process.env.KYBERION_OPENROUTER_COST_POLICY;
    delete process.env.KYBERION_OPENROUTER_REQUIRED_PARAMETERS;
    delete process.env.KYBERION_OPENROUTER_URL;
  });

  it('builds from env when an OpenRouter API key is configured', () => {
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    process.env.KYBERION_OPENROUTER_MODEL = 'meta-llama/llama-3-70b-instruct';
    process.env.KYBERION_OPENROUTER_COST_POLICY = 'paid-allowed';

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
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
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

  it('probes the authenticated models endpoint without making a completion request', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'openrouter/free',
              pricing: { prompt: '0', completion: '0', request: '0' },
              supported_parameters: ['tools', 'tool_choice'],
            },
          ],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeOpenRouterBackendAvailability({
      OPENROUTER_API_KEY: 'or-test-key',
    });

    expect(result).toEqual({ available: true });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://openrouter.ai/api/v1/models'),
      expect.objectContaining({
        method: 'GET',
        headers: { authorization: 'Bearer or-test-key' },
      })
    );
  });

  it('does not probe OpenRouter when no API key is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeOpenRouterBackendAvailability({});

    expect(result.available).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed completion messages instead of narrowing them by assertion', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ choices: [{ message: { role: 'assistant', content: 42 } }] }),
            { status: 200 }
          )
        )
    );

    const backend = new OpenRouterBackend({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'or-test-key',
      model: 'openrouter/free',
    });

    await expect(backend.prompt('Say hello')).rejects.toThrow('invalid chat completion response');
  });

  it('rejects non-object tool arguments before a tool path is resolved', async () => {
    const backend = new OpenRouterBackend({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'or-test-key',
      model: 'openrouter/free',
      toolsEnabled: true,
      allowedTools: ['read_file'],
    });
    const result = await (
      backend as unknown as {
        handleToolCall(name: string, args: string): Promise<string>;
      }
    ).handleToolCall('read_file', '[]');

    expect(result).toBe('Error: OpenRouter tool arguments must be a JSON object.');
  });

  it('rejects model file tools that traverse a symbolic link', async () => {
    const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'active/shared/tmp/openrouter-tool-'));
    const targetDir = path.join(tempDir, 'target');
    const linkDir = path.join(tempDir, 'linked');
    fs.mkdirSync(targetDir);
    fs.symlinkSync(targetDir, linkDir, 'dir');
    try {
      const backend = new OpenRouterBackend({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'or-test-key',
        model: 'meta-llama/llama-3-70b-instruct',
        toolsEnabled: true,
        allowedTools: ['read_file'],
      });
      const result = await (
        backend as unknown as {
          handleToolCall(name: string, args: string): Promise<string>;
        }
      ).handleToolCall(
        'read_file',
        JSON.stringify({ path: path.relative(process.cwd(), path.join(linkDir, 'secret.txt')) })
      );
      expect(result).toContain('[RESOURCE_PATH_SYMLINK]');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

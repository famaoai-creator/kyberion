import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  OpenAiCompatibleBackend,
  buildNemotronBackendFromEnv,
  buildOpenAiCompatibleBackendFromEnv,
  buildOllamaBackendFromEnv,
  buildVllmBackendFromEnv,
  buildLmStudioBackendFromEnv,
  buildLlamaCppBackendFromEnv,
  buildMlxBackendFromEnv,
  buildLocalAiBackendFromEnv,
} from './openai-compatible-backend.js';

vi.mock('./secure-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secure-io.js')>();
  return {
    ...actual,
    safeExec: vi.fn(() => 'shell-ok'),
    safeReadFile: vi.fn(() => 'file contents'),
    safeReaddir: vi.fn(() => ['a.txt', 'b.txt']),
    safeWriteFile: vi.fn(),
  };
});

describe('openai-compatible-backend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.KYBERION_LOCAL_LLM_URL;
    delete process.env.KYBERION_LOCAL_LLM_KEY;
    delete process.env.KYBERION_LOCAL_LLM_MODEL;
    delete process.env.KYBERION_OLLAMA_URL;
    delete process.env.OLLAMA_HOST;
    delete process.env.KYBERION_OLLAMA_MODEL;
    delete process.env.OLLAMA_MODEL;
    delete process.env.KYBERION_VLLM_URL;
    delete process.env.KYBERION_VLLM_MODEL;
    delete process.env.KYBERION_LMSTUDIO_URL;
    delete process.env.KYBERION_LM_STUDIO_URL;
    delete process.env.KYBERION_LMSTUDIO_MODEL;
    delete process.env.KYBERION_LLAMACPP_URL;
    delete process.env.KYBERION_LLAMACPP_MODEL;
    delete process.env.KYBERION_MLX_URL;
    delete process.env.KYBERION_MLX_MODEL;
    delete process.env.KYBERION_LOCALAI_URL;
    delete process.env.KYBERION_LOCALAI_MODEL;
    delete process.env.KYBERION_NEMOTRON_URL;
    delete process.env.KYBERION_NEMOTRON_KEY;
    delete process.env.KYBERION_NEMOTRON_MODEL;
    delete process.env.KYBERION_CONTEXT_WINDOW_TOKENS;
  });

  const okTextResponse = () =>
    new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('builds from env when a local llm url is configured', () => {
    process.env.KYBERION_LOCAL_LLM_URL = 'http://127.0.0.1:11434/v1';
    process.env.KYBERION_LOCAL_LLM_MODEL = 'llama3.2';

    const backend = buildOpenAiCompatibleBackendFromEnv();
    expect(backend?.name).toBe('openai-compatible');
    expect(backend?.providerPreset).toBe('generic');
  });

  it('builds Ollama backend and normalizes URL to /v1', () => {
    process.env.KYBERION_OLLAMA_URL = 'http://localhost:11434';
    process.env.KYBERION_OLLAMA_MODEL = 'qwen2.5-coder';

    const backend = buildOllamaBackendFromEnv();
    expect(backend?.name).toBe('openai-compatible');
    expect(backend?.providerPreset).toBe('ollama');
  });

  it('builds vLLM, LM Studio, llama.cpp, MLX, and LocalAI backends from env', () => {
    process.env.KYBERION_VLLM_URL = 'http://localhost:8000/v1';
    expect(buildVllmBackendFromEnv()?.providerPreset).toBe('vllm');

    process.env.KYBERION_LMSTUDIO_URL = 'http://localhost:1234/v1';
    expect(buildLmStudioBackendFromEnv()?.providerPreset).toBe('lmstudio');

    process.env.KYBERION_LLAMACPP_URL = 'http://localhost:8080/v1';
    expect(buildLlamaCppBackendFromEnv()?.providerPreset).toBe('llamacpp');

    process.env.KYBERION_MLX_URL = 'http://localhost:8080/v1';
    expect(buildMlxBackendFromEnv()?.providerPreset).toBe('mlx');

    process.env.KYBERION_LOCALAI_URL = 'http://localhost:8080/v1';
    expect(buildLocalAiBackendFromEnv()?.providerPreset).toBe('localai');
  });

  it('builds a Nemotron backend from the Nemotron-compatible env vars', () => {
    process.env.KYBERION_NEMOTRON_URL = 'https://integrate.api.nvidia.com/v1';
    process.env.KYBERION_NEMOTRON_MODEL = 'nemotron';

    const backend = buildNemotronBackendFromEnv();
    expect(backend?.name).toBe('openai-compatible');
  });

  it('rejects a public endpoint when constructing a local runtime', () => {
    expect(
      () =>
        new OpenAiCompatibleBackend({
          baseURL: 'https://unexpected.example.invalid/v1',
          apiKey: 'not-needed',
          model: 'llama3',
        })
    ).toThrow(/Local LLM endpoint/);
  });

  it('runs a tool loop against an OpenAI-compatible endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ path: 'README.md' }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
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

    const backend = new OpenAiCompatibleBackend({
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: 'not-needed',
      model: 'llama3',
      timeoutMs: 1_000,
      toolsEnabled: true,
      allowedTools: ['read_file'],
    });

    const result = await backend.prompt('Read the file', {
      token: 'top-secret-token',
      nested: {
        apiKey: 'sk-test-1234567890abcdef',
      },
    });

    expect(result).toBe('done');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(firstBody.messages[1].content).not.toContain('top-secret-token');
    expect(firstBody.messages[1].content).not.toContain('sk-test-1234567890abcdef');
  });

  it('rejects malformed chat completion message and tool-call shapes', async () => {
    for (const payload of [
      [],
      { choices: [{ message: { role: 'assistant', content: 42 } }] },
      { choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [{}] } }] },
      { choices: [{ message: { role: 'assistant', content: [{ type: 'text' }] } }] },
      { choices: [{ message: { role: 'assistant', content: 'ok', nested: { constructor: {} } } }] },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      );
      const backend = new OpenAiCompatibleBackend({
        baseURL: 'http://127.0.0.1:11434/v1',
        apiKey: 'not-needed',
        model: 'llama3',
      });
      await expect(backend.prompt('malformed response')).rejects.toThrow(
        'invalid chat completion response'
      );
    }
  });

  it('rejects model file tools that traverse a symbolic link', async () => {
    const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'active/shared/tmp/openai-tool-'));
    const targetDir = path.join(tempDir, 'target');
    const linkDir = path.join(tempDir, 'linked');
    fs.mkdirSync(targetDir);
    fs.symlinkSync(targetDir, linkDir, 'dir');
    try {
      const backend = new OpenAiCompatibleBackend({
        baseURL: 'http://127.0.0.1:11434/v1',
        apiKey: 'not-needed',
        model: 'llama3',
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

  it('returns caller-provided governed tool calls without executing them', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'I will inspect the capability.',
                tool_calls: [
                  {
                    id: 'call-capability',
                    type: 'function',
                    function: {
                      name: 'capability_read',
                      arguments: JSON.stringify({ name: 'browser' }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const backend = new OpenAiCompatibleBackend({
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: 'not-needed',
      model: 'deepseek-coder',
    });

    const result = await backend.generateWithTools(
      'Find the browser capability.',
      [
        {
          name: 'capability_read',
          description: 'Read one governed capability description.',
          inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
      ],
      {
        deferred_tool_definitions: [
          {
            name: 'not_active',
            description: 'Deferred',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      }
    );

    expect(result).toEqual({
      text: 'I will inspect the capability.',
      toolCalls: [{ name: 'capability_read', input: { name: 'browser' } }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.tools).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({ name: 'capability_read' }),
      }),
    ]);
    expect(body.tools).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          function: expect.objectContaining({ name: 'not_active' }),
        }),
      ])
    );
  });

  it('streams OpenAI-compatible text deltas without waiting for the full response', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"最初の"}}]}\n\n')
        );
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"文です。"}}]}\n\n')
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      );
    vi.stubGlobal('fetch', fetchMock);
    const backend = new OpenAiCompatibleBackend({
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: 'not-needed',
      model: 'qwen2.5',
    });

    const deltas: string[] = [];
    for await (const delta of backend.streamPrompt('say hello')) deltas.push(delta);

    expect(deltas).toEqual(['最初の', '文です。']);
    const bodyJson = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(bodyJson.stream).toBe(true);
  });

  it('ignores malformed streaming deltas before yielding text', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":42}}]}\n\n'));
        controller.enqueue(encoder.encode('data: []\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        )
    );
    const backend = new OpenAiCompatibleBackend({
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: 'not-needed',
      model: 'qwen2.5',
    });

    const deltas: string[] = [];
    for await (const delta of backend.streamPrompt('malformed stream')) deltas.push(delta);
    expect(deltas).toEqual(['ok']);
  });

  it('rejects non-object tool arguments before any tool side effect', async () => {
    const backend = new OpenAiCompatibleBackend({
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: 'not-needed',
      model: 'qwen2.5',
      toolsEnabled: true,
      allowedTools: ['shell_exec'],
    });
    const result = await (
      backend as unknown as {
        handleToolCall(name: string, args: string): Promise<string>;
      }
    ).handleToolCall('shell_exec', '[]');
    expect(result).toContain('arguments must be a JSON object');
  });

  it('does not advertise tools unless the route explicitly enables an allowlist', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okTextResponse());
    vi.stubGlobal('fetch', fetchMock);
    const backend = new OpenAiCompatibleBackend({
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: 'not-needed',
      model: 'llama3',
      timeoutMs: 1_000,
    });
    await backend.prompt('hello');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('propagates delegation cancellation to the OpenAI-compatible fetch', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const backend = new OpenAiCompatibleBackend({
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: 'not-needed',
      model: 'llama3',
      timeoutMs: 60_000,
    });

    const pending = backend.delegateTask('wait', undefined, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow('aborted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('stops repeated identical tool calls through the guardrail', async () => {
    const makeResponse = (id: string) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id,
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: JSON.stringify({ path: 'README.md' }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    let fetchCount = 0;
    const fetchMock = vi.fn(() => {
      fetchCount += 1;
      return makeResponse(fetchCount === 1 ? 'call-1' : fetchCount === 2 ? 'call-2' : 'call-3');
    });

    vi.stubGlobal('fetch', fetchMock);

    const backend = new OpenAiCompatibleBackend({
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: 'not-needed',
      model: 'llama3',
      timeoutMs: 1_000,
      toolsEnabled: true,
      allowedTools: ['read_file'],
    });

    const result = await backend.prompt('Read the file');

    expect(result).toContain('stopped after 3 repeated calls to read_file');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(firstBody.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: expect.any(String),
          parameters: expect.any(Object),
        },
      },
    ]);
  });

  it('budgets max_tokens against a configured context window', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okTextResponse());
    vi.stubGlobal('fetch', fetchMock);

    const backend = new OpenAiCompatibleBackend({
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: 'not-needed',
      model: 'llama3',
      timeoutMs: 1_000,
      contextWindowTokens: 16_000,
      maxCompletionTokens: 8_000,
    });

    await backend.prompt('y'.repeat(24_000));

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.max_tokens).toBeLessThan(8_000);
    expect(body.max_tokens).toBeGreaterThanOrEqual(1_024);
  });

  it('sends no max_tokens when the context window is unknown', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okTextResponse());
    vi.stubGlobal('fetch', fetchMock);

    const backend = new OpenAiCompatibleBackend({
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: 'not-needed',
      model: 'llama3',
      timeoutMs: 1_000,
    });

    await backend.prompt('short prompt');

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.max_tokens).toBeUndefined();
  });

  it('injects governed sampling parameters without inventing a context window', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okTextResponse());
    vi.stubGlobal('fetch', fetchMock);

    const backend = new OpenAiCompatibleBackend({
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: 'not-needed',
      model: 'qwen2.5-coder',
      providerPreset: 'ollama',
      samplingParams: { temperature: 0.2, top_p: 0.9, top_k: 20, min_p: 0.05 },
    });

    await backend.prompt('classify this');

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.9);
    expect(body.top_k).toBe(20);
    expect(body.min_p).toBe(0.05);
    expect(body.max_tokens).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OpenAiCompatibleBackend,
  buildNemotronBackendFromEnv,
  buildOpenAiCompatibleBackendFromEnv,
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
    delete process.env.KYBERION_NEMOTRON_URL;
    delete process.env.KYBERION_NEMOTRON_KEY;
    delete process.env.KYBERION_NEMOTRON_MODEL;
  });

  it('builds from env when a local llm url is configured', () => {
    process.env.KYBERION_LOCAL_LLM_URL = 'http://127.0.0.1:11434/v1';
    process.env.KYBERION_LOCAL_LLM_MODEL = 'llama3.2';

    const backend = buildOpenAiCompatibleBackendFromEnv();
    expect(backend?.name).toBe('openai-compatible');
  });

  it('builds a Nemotron backend from the Nemotron-compatible env vars', () => {
    process.env.KYBERION_NEMOTRON_URL = 'https://integrate.api.nvidia.com/v1';
    process.env.KYBERION_NEMOTRON_MODEL = 'nemotron';

    const backend = buildNemotronBackendFromEnv();
    expect(backend?.name).toBe('openai-compatible');
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
    });

    const result = await backend.prompt('Read the file');

    expect(result).toContain('stopped after 3 repeated calls to read_file');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

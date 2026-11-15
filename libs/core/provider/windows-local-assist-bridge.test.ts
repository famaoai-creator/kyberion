import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as platform from '../platform-facts.js';
const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock('../secure-io.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../secure-io.js')>()),
  safeExecResult: execMock,
}));
import {
  _resetWindowsLocalAssistAvailabilityCacheForTests,
  windowsLocalAssistPrompt,
  probeWindowsLocalAssist,
  classifyLocallyWithWindowsAi,
} from './windows-local-assist-bridge.js';

describe('windows local assist bridge', () => {
  beforeEach(() => {
    vi.stubEnv('KYBERION_WINDOWS_AI', '1');
    vi.stubEnv('KYBERION_WINDOWS_AI_ENDPOINT', 'http://127.0.0.1:5272');
    vi.stubEnv('KYBERION_WINDOWS_AI_MODEL', 'test-model');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    execMock.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    _resetWindowsLocalAssistAvailabilityCacheForTests();
  });

  it('discovers the local endpoint and returns chat text', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ endpoint: 'http://127.0.0.1:6000' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: '  hello  ' } }] }), {
          status: 200,
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    process.env.KYBERION_WINDOWS_AI_ENDPOINT = 'http://127.0.0.1:5272';

    await expect(windowsLocalAssistPrompt('say hello')).resolves.toBe('hello');
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:5272/openai/status');
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:6000/v1/chat/completions');
  });

  it('accepts only an exact supplied classification', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'support' } }] }), {
          status: 200,
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    process.env.KYBERION_WINDOWS_AI_ENDPOINT = 'http://127.0.0.1:5272';

    await expect(classifyLocallyWithWindowsAi('help me', ['support', 'sales'])).resolves.toBe(
      'support'
    );
  });

  it('fails closed when the chat response content is not a string', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: { leaked: true } } }] }), {
          status: 200,
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    process.env.KYBERION_WINDOWS_AI_ENDPOINT = 'http://127.0.0.1:5272';

    await expect(windowsLocalAssistPrompt('malformed response')).resolves.toBeNull();
  });

  it('ignores an endpoint from a status response with a dangerous key', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"endpoint":"http://127.0.0.1:6000","__proto__":{}}', { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'safe fallback' } }] }), {
          status: 200,
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    process.env.KYBERION_WINDOWS_AI_ENDPOINT = 'http://127.0.0.1:5272';

    await expect(windowsLocalAssistPrompt('use fallback')).resolves.toBe('safe fallback');
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:5272/v1/chat/completions');
  });
  it('honors disabling immediately after a successful cached probe', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(probeWindowsLocalAssist()).resolves.toMatchObject({ available: true });
    vi.stubEnv('KYBERION_WINDOWS_AI', 'off');
    await expect(windowsLocalAssistPrompt('must stay local and disabled')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('invalidates cached endpoint and model when configuration changes', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await probeWindowsLocalAssist();
    vi.stubEnv('KYBERION_WINDOWS_AI_ENDPOINT', 'http://127.0.0.1:6000');
    vi.stubEnv('KYBERION_WINDOWS_AI_MODEL', 'new-model');
    await expect(probeWindowsLocalAssist()).resolves.toMatchObject({
      endpoint: 'http://127.0.0.1:6000',
      model: 'new-model',
    });
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:6000/openai/status');
  });

  it('accepts an OpenAI base URL ending in /v1 without duplicating the prefix', async () => {
    vi.stubEnv('KYBERION_WINDOWS_AI_ENDPOINT', ' http://127.0.0.1:6000/v1/ ');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(new Response('{"data":[{"id":"test-model"}]}'))
      .mockResolvedValueOnce(new Response('{"choices":[{"message":{"content":"hello"}}]}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(windowsLocalAssistPrompt('hello')).resolves.toBe('hello');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:6000/openai/status',
      'http://127.0.0.1:6000/v1/models',
      'http://127.0.0.1:6000/v1/chat/completions',
    ]);
  });

  it('does not send a prompt if disabled while endpoint discovery is in flight', async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          })
      )
      .mockResolvedValue(
        new Response('{"choices":[{"message":{"content":"should not be sent"}}]}')
      );
    vi.stubGlobal('fetch', fetchMock);
    const prompt = windowsLocalAssistPrompt('private text');
    vi.stubEnv('KYBERION_WINDOWS_AI', '0');
    finish(new Response('{}'));
    await expect(prompt).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not reuse an old discovery after the endpoint changes mid-flight', async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          })
      )
      .mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const oldProbe = probeWindowsLocalAssist();
    vi.stubEnv('KYBERION_WINDOWS_AI_ENDPOINT', 'http://127.0.0.1:6000');
    await probeWindowsLocalAssist();
    finish(new Response('{}'));
    await oldProbe;
    await expect(probeWindowsLocalAssist()).resolves.toMatchObject({
      endpoint: 'http://127.0.0.1:6000',
    });
  });

  it.each([
    ['KYBERION_WINDOWS_AI', 'off'],
    ['KYBERION_WINDOWS_AI_ENDPOINT', 'http://127.0.0.1:7000'],
    ['KYBERION_WINDOWS_AI_MODEL', 'another-model'],
  ])('does not send cached prompts across a change to %s', async (name, value) => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await probeWindowsLocalAssist();
    const pending = windowsLocalAssistPrompt('private');
    vi.stubEnv(name, value);
    await expect(pending).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('resolves a Foundry model alias to its native model ID before sending', async () => {
    vi.spyOn(platform, 'isWindows').mockReturnValue(true);
    vi.stubEnv('KYBERION_WINDOWS_AI_ENDPOINT', '');
    vi.stubEnv('KYBERION_WINDOWS_AI_MODEL', 'qwen2.5-0.5b');
    execMock
      .mockReturnValueOnce({ status: 0, stdout: '{"webUrls":["http://127.0.0.1:6000"]}' })
      .mockReturnValueOnce({
        status: 0,
        stdout: '{"model":{"id":"qwen2.5-0.5b-instruct-generic-cpu:4"}}',
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(new Response('{"choices":[{"message":{"content":"OK"}}]}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(windowsLocalAssistPrompt('Reply OK')).resolves.toBe('OK');
    expect(execMock.mock.calls[1].slice(0, 2)).toEqual([
      'foundry',
      ['model', 'info', 'qwen2.5-0.5b', '--output', 'json'],
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe(
      'qwen2.5-0.5b-instruct-generic-cpu:4'
    );
  });
  it.each([
    { status: 1, stdout: '' },
    { status: 0, stdout: '{"model":{"id":42}}' },
    { status: 0, stdout: '{"model":{"id":"   "}}' },
    { status: 0, stdout: '{"model":{"id":"untrusted"},"__proto__":{}}' },
  ])('keeps the configured model when CLI model info is invalid: %j', async (info) => {
    vi.spyOn(platform, 'isWindows').mockReturnValue(true);
    vi.stubEnv('KYBERION_WINDOWS_AI_ENDPOINT', '');
    execMock
      .mockReturnValueOnce({ status: 0, stdout: '{"webUrls":["http://127.0.0.1:6000"]}' })
      .mockReturnValueOnce(info);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
    await expect(probeWindowsLocalAssist()).resolves.toMatchObject({ model: 'test-model' });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetWindowsLocalAssistAvailabilityCacheForTests,
  windowsLocalAssistPrompt,
  classifyLocallyWithWindowsAi,
} from './windows-local-assist-bridge.js';

describe('windows local assist bridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KYBERION_WINDOWS_AI_ENDPOINT;
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
});

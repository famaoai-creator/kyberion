import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runInExecutionScope } from '../foundation/execution-scope.js';
const mocks = vi.hoisted(() => ({ request: vi.fn(), assertEgress: vi.fn() }));
vi.mock('../reasoning/reasoning-egress-scope.js', () => ({
  assertReasoningEgressAllowedAtEndpoint: mocks.assertEgress,
}));
import {
  OpenAiResponsesBackend,
  buildOpenAiResponsesBackendFromEnv,
  extractOpenAiResponseText,
} from './openai-responses-backend.js';

function completed(text: string) {
  return {
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
});

describe('OpenAI Responses adapter', () => {
  it('refuses to reuse an operator client in a tenant execution', async () => {
    const backend = new OpenAiResponsesBackend({
      apiKey: 'operator-key',
      model: 'test-model',
      request: mocks.request,
    });
    await expect(
      runInExecutionScope({ tenantBound: true, tenantSlug: 'alpha' }, () => backend.prompt('hello'))
    ).rejects.toThrow('CREDENTIAL_OWNER_DENIED');
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('requires both an API key and explicit API model; Codex CLI state does not substitute', () => {
    expect(buildOpenAiResponsesBackendFromEnv({ CODEX_CLI: '1' })).toBeNull();
    expect(buildOpenAiResponsesBackendFromEnv({ OPENAI_API_KEY: 'key' })).toBeNull();
    expect(
      buildOpenAiResponsesBackendFromEnv({
        OPENAI_API_KEY: 'key',
        KYBERION_OPENAI_MODEL: 'test-codex',
      })?.name
    ).toBe('openai-api');
  });
  it('uses Responses with bearer authentication, no storage, and no redirects', async () => {
    mocks.request.mockResolvedValue(completed('OK'));
    const backend = new OpenAiResponsesBackend({
      apiKey: 'test-private-key',
      model: 'test-codex',
      maxOutputTokens: 256,
      request: mocks.request,
    });
    await expect(backend.prompt('Reply OK')).resolves.toBe('OK');
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0][0]).toMatchObject({
      url: 'https://api.openai.com/v1/responses',
      maxRedirects: 0,
      authenticateRequest: true,
      headers: { authorization: 'Bearer test-private-key' },
      data: { model: 'test-codex', store: false, stream: false, max_output_tokens: 256 },
    });
    expect(mocks.request.mock.calls[0][0].data).not.toHaveProperty('tools');
    expect(mocks.assertEgress).toHaveBeenCalledWith(
      'openai-api',
      'https://api.openai.com/v1/responses'
    );
  });
  it('keeps the shared structured reasoning operations on the Responses transport', async () => {
    const sketches = [{ id: 'H1', proposed_by: 'Architect', content: 'Try a small safe change' }];
    mocks.request.mockResolvedValue(completed(JSON.stringify({ hypotheses: sketches })));
    const backend = new OpenAiResponsesBackend({
      apiKey: 'test-key',
      model: 'test-model',
      request: mocks.request,
    });
    await expect(
      backend.divergePersonas({ topic: 'test', personas: ['Architect'] })
    ).resolves.toEqual(sketches);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it('does not fall back to Chat Completions when using the streaming facade', async () => {
    mocks.request.mockResolvedValue(completed('Hello'));
    const backend = new OpenAiResponsesBackend({
      apiKey: 'test-key',
      model: 'test-model',
      request: mocks.request,
    });
    const chunks: string[] = [];
    for await (const chunk of backend.streamPrompt('hello')) chunks.push(chunk);
    expect(chunks).toEqual(['Hello']);
    expect(mocks.request.mock.calls[0][0].url).toBe('https://api.openai.com/v1/responses');
  });
  it('checks cancellation and egress policy before transmitting credentials', async () => {
    const controller = new AbortController();
    controller.abort();
    const backend = new OpenAiResponsesBackend({
      apiKey: 'test-key',
      model: 'test-model',
      request: mocks.request,
    });
    await expect(backend.prompt('hello', { signal: controller.signal })).rejects.toThrow('aborted');
    expect(mocks.request).not.toHaveBeenCalled();
    mocks.assertEgress.mockImplementation(() => {
      throw new Error('egress denied');
    });
    await expect(backend.prompt('hello')).rejects.toThrow('egress denied');
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each([
    { status: 'incomplete', output: completed('OK').output },
    { status: 'completed', output: [] },
    { status: 'failed', error: { message: 'test-private-key' } },
  ])('rejects incomplete or error responses', async (body) => {
    expect(extractOpenAiResponseText(body)).toBeNull();
    mocks.request.mockResolvedValue(body);
    const backend = new OpenAiResponsesBackend({
      apiKey: 'test-key',
      model: 'test-model',
      request: mocks.request,
    });
    await expect(backend.prompt('hello')).rejects.toThrow('no completed text response');
  });
  it('suppresses raw provider errors without retrying', async () => {
    mocks.request.mockRejectedValue(new Error('test-private-key'));
    const backend = new OpenAiResponsesBackend({
      apiKey: 'test-private-key',
      model: 'test-model',
      request: mocks.request,
    });
    await expect(backend.prompt('hello')).rejects.toThrow('[openai] API request failed');
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
});

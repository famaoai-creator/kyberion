import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getReasoningPayloadScope,
  getReasoningTrainingUseCap,
} from '@agent/core/reasoning/reasoning-egress-scope';
import { ScriptExitError } from '../lib/harness.js';
import { main } from './onboarding_llm.js';
import { probeLocalDelegation } from './onboarding_llm_probe_local.js';

const input = { url: 'http://127.0.0.1:11460', model: 'synthetic-model:latest' };

function modelResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('onboarding llm probe-local', () => {
  it('delegates a single capped task with no tools, API keys, fallback, or redirects', async () => {
    vi.stubEnv('KYBERION_REASONING_BACKEND', 'codex-cli');
    vi.stubEnv('KYBERION_HARNESS_SUBAGENT', '1');
    vi.stubEnv('KYBERION_OLLAMA_KEY', 'never-use-in-probe');
    const fetcher = vi.fn(async () => {
      expect(getReasoningTrainingUseCap()).toBe('local_only');
      expect(getReasoningPayloadScope()).toMatchObject({
        tier: 'public',
        training_use: 'local_only',
      });
      return modelResponse('42\n');
    });
    vi.stubGlobal('fetch', fetcher);
    const print = vi.fn();
    await main(['probe-local', '--url', input.url, '--model', input.model, '--json'], print);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:11460/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        signal: expect.any(AbortSignal),
        headers: { 'content-type': 'application/json' },
      })
    );
    const [, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: input.model,
      max_tokens: 512,
    });
    expect(JSON.parse(String(request.body))).not.toHaveProperty('tools');
    expect(JSON.parse(print.mock.calls[0][0])).toMatchObject({
      status: 'passed',
      provider: 'ollama',
      training_use: 'local_only',
      model: input.model,
    });
  });

  it.each([
    'https://external.example/v1',
    'http://127.example/v1',
    'http://192.168.0.1/v1',
    'http://name:secret@127.0.0.1/v1',
    'http://127.0.0.1/unexpected',
  ])('rejects invalid or non-loopback endpoint %s without network I/O', async (url) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await probeLocalDelegation({ ...input, url })).toMatchObject({
      status: 'invalid_configuration',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a cloud model before delegating', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await probeLocalDelegation({ ...input, model: 'synthetic-model:cloud' })).toMatchObject({
      status: 'invalid_configuration',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports an incorrect result with a nonzero exit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => modelResponse('41'))
    );
    const print = vi.fn();
    await expect(
      main(['probe-local', '--url', input.url, '--model', input.model, '--json'], print)
    ).rejects.toBeInstanceOf(ScriptExitError);
    expect(JSON.parse(print.mock.calls[0][0])).toMatchObject({ status: 'incorrect_result' });
  });

  it('reports an unavailable endpoint without retrying or surfacing its error text', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('private network detail');
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await probeLocalDelegation(input);
    expect(result.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('private network detail');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a deadline from an unavailable endpoint and refuses an unbounded wait', async () => {
    const fetcher = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await probeLocalDelegation({ ...input, timeoutMs: '180001' })).toMatchObject({
      status: 'invalid_configuration',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await probeLocalDelegation({ ...input, timeoutMs: '120000' })).toMatchObject({
      status: 'timed_out',
      timeout_ms: 120000,
      next_step: expect.stringContaining('--timeout-ms'),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

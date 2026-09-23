// PA-09: POST /api/voice/synthesize — same fake-app pattern as
// `training-routes.test.ts`: register the real route onto a recorder of
// `METHOD path` handlers and drive it with fake req/res and an injected fetch
// (no network, no voice-hub).
import { describe, expect, it, vi } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  VOICE_SYNTHESIZE_MAX_TEXT_CHARS,
  readVoiceSynthesizeUpstream,
  registerVoiceSynthesizeRoute,
} from './voice-synthesize-route.js';

type Handler = (req: unknown, res: unknown) => Promise<unknown> | unknown;

function createFakeApp() {
  const handlers = new Map<string, Handler>();
  const fake = {
    get(routePath: string, handler: Handler) {
      handlers.set(`GET ${routePath}`, handler);
    },
    post(routePath: string, handler: Handler) {
      handlers.set(`POST ${routePath}`, handler);
    },
  };
  return { app: fake as unknown as import('express').Express, handlers };
}

function fakeRequest(options: { remoteAddress?: string; authorization?: string; body?: unknown }) {
  const urlPath = '/api/voice/synthesize';
  return {
    method: 'POST',
    params: {},
    query: {},
    body: options.body,
    headers: options.authorization ? { authorization: options.authorization } : {},
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    path: urlPath,
    originalUrl: urlPath,
    url: urlPath,
  } as never;
}

function fakeResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    ended: undefined as Buffer | undefined,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    end(chunk?: Buffer) {
      res.ended = chunk;
      return res;
    },
  };
  return res;
}

const WAV = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'), Buffer.alloc(64)]);

function wavResponse(headers: Record<string, string> = {}) {
  return new Response(WAV, {
    status: 200,
    headers: {
      'content-type': 'audio/wav',
      'x-kyberion-speech-engine': 'native_say',
      'x-kyberion-speech-duration-ms': '1234',
      'x-kyberion-speech-language': 'en',
      ...headers,
    },
  });
}

function setup(fetchImpl: typeof fetch) {
  const { app, handlers } = createFakeApp();
  registerVoiceSynthesizeRoute(app, { voiceHubUrl: 'http://127.0.0.1:3032', fetchImpl });
  return handlers.get('POST /api/voice/synthesize')!;
}

describe('POST /api/voice/synthesize', () => {
  it('is registered from server.ts behind the shared /api guard', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('presence/displays/presence-studio/server.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('registerVoiceSynthesizeRoute(presenceStudioData.app);');
  });

  it('streams WAV bytes from voice-hub with timing headers and no caching', async () => {
    const fetchImpl = vi.fn(async () => wavResponse());
    const handler = setup(fetchImpl as unknown as typeof fetch);
    const res = fakeResponse();

    await handler(fakeRequest({ body: { text: 'hello', language: 'en-US' } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.ended?.equals(WAV)).toBe(true);
    expect(res.headers).toMatchObject({
      'cache-control': 'no-store',
      'content-type': 'audio/wav',
      'x-content-type-options': 'nosniff',
      'x-kyberion-speech-engine': 'native_say',
      'x-kyberion-speech-duration-ms': '1234',
      'x-kyberion-speech-language': 'en',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:3032/api/speech/synthesize',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'hello', language: 'en-US' }),
      })
    );
  });

  it('passes a 501 through so the browser falls back to speechSynthesis', async () => {
    const handler = setup((async () =>
      Response.json(
        { ok: false, error: 'synthesis_unsupported', reason: 'native_tts_file_output_unsupported' },
        { status: 501 }
      )) as unknown as typeof fetch);
    const res = fakeResponse();
    await handler(fakeRequest({ body: { text: 'hello' } }), res);
    expect(res.statusCode).toBe(501);
    expect(res.body).toEqual({
      ok: false,
      error: 'synthesis_unsupported',
      reason: 'native_tts_file_output_unsupported',
    });
  });

  it('answers 503 when voice-hub is unreachable', async () => {
    const handler = setup((async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    const res = fakeResponse();
    await handler(fakeRequest({ body: { text: 'hello' } }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'voice_hub_unreachable' });
  });

  it.each([
    ['missing text', {}, 400],
    ['unknown field', { text: 'hi', play: true }, 400],
    ['bad language', { text: 'hi', language: 'fr' }, 400],
    ['text over the cap', { text: 'a'.repeat(VOICE_SYNTHESIZE_MAX_TEXT_CHARS + 1) }, 413],
  ])('rejects %s before contacting voice-hub', async (_label, body, status) => {
    const fetchImpl = vi.fn();
    const handler = setup(fetchImpl as unknown as typeof fetch);
    const res = fakeResponse();
    await handler(fakeRequest({ body }), res);
    expect(res.statusCode).toBe(status);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a remote (non-loopback) viewer before contacting voice-hub', async () => {
    const original = process.env.PRESENCE_STUDIO_TOKEN;
    process.env.PRESENCE_STUDIO_TOKEN = 'synth-route-test-token';
    try {
      const fetchImpl = vi.fn();
      const handler = setup(fetchImpl as unknown as typeof fetch);
      const res = fakeResponse();
      await handler(
        fakeRequest({
          remoteAddress: '192.0.2.10',
          authorization: 'Bearer synth-route-test-token',
          body: { text: 'hello' },
        }),
        res
      );
      expect(res.statusCode).toBeGreaterThanOrEqual(401);
      expect(res.statusCode).toBeLessThan(404);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.PRESENCE_STUDIO_TOKEN;
      else process.env.PRESENCE_STUDIO_TOKEN = original;
    }
  });
});

describe('readVoiceSynthesizeUpstream', () => {
  it('drops malformed timing headers instead of forwarding them', async () => {
    const result = await readVoiceSynthesizeUpstream(
      wavResponse({ 'x-kyberion-speech-duration-ms': '12ms', 'x-kyberion-speech-engine': 'a b' })
    );
    expect(result.kind).toBe('audio');
    if (result.kind !== 'audio') return;
    expect(result.headers).toEqual({ 'x-kyberion-speech-language': 'en' });
  });

  it('maps non-audio, non-JSON answers to 502', async () => {
    expect(
      await readVoiceSynthesizeUpstream(
        new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
      )
    ).toEqual({
      kind: 'json',
      status: 502,
      body: { ok: false, error: 'invalid_voice_hub_response' },
    });
  });
});

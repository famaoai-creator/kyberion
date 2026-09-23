import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const guard = vi.hoisted(() => ({ denied: null as Response | null }));

vi.mock('../../../../lib/api-guard', () => ({
  requireConciergeMutationAccess: vi.fn(() => guard.denied),
}));
vi.mock('../../../../lib/voice-hub', () => ({
  voiceHubUrl: vi.fn(() => 'http://127.0.0.1:4173'),
}));

import { POST, VOICE_SYNTHESIZE_MAX_TEXT_CHARS } from './route.js';

function request(body: unknown) {
  return {
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as NextRequest;
}

const WAV = new Uint8Array([
  ...new TextEncoder().encode('RIFF\0\0\0\0WAVE'),
  ...new Uint8Array(32),
]);

afterEach(() => {
  guard.denied = null;
  vi.restoreAllMocks();
});

describe('concierge POST /api/voice/synthesize', () => {
  it('streams voice-hub WAV bytes with timing headers and no caching', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(WAV, {
        status: 200,
        headers: {
          'content-type': 'audio/wav',
          'x-kyberion-speech-engine': 'native_say',
          'x-kyberion-speech-duration-ms': '900',
          'x-kyberion-speech-language': 'ja',
          'x-unrelated': 'dropped',
        },
      })
    );

    const response = await POST(request({ text: ' こんにちは ', language: 'ja-JP' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-kyberion-speech-duration-ms')).toBe('900');
    expect(response.headers.get('x-kyberion-speech-engine')).toBe('native_say');
    expect(response.headers.get('x-unrelated')).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WAV);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:4173/api/speech/synthesize',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'こんにちは', language: 'ja-JP' }),
      })
    );
  });

  it('passes voice-hub 501 through so the player falls back', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ ok: false, error: 'synthesis_unsupported', reason: 'x' }, { status: 501 })
    );
    const response = await POST(request({ text: 'hello' }));
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'synthesis_unsupported',
      reason: 'x',
    });
  });

  it('answers 503 when voice-hub is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const response = await POST(request({ text: 'hello' }));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('voice_hub_unreachable');
  });

  it.each([
    ['null body', null, 400],
    ['missing text', {}, 400],
    ['text number', { text: 1 }, 400],
    ['unknown field', { text: 'hi', play: true }, 400],
    ['bad language', { text: 'hi', language: 'fr' }, 400],
    ['text over cap', { text: 'a'.repeat(VOICE_SYNTHESIZE_MAX_TEXT_CHARS + 1) }, 413],
  ])('rejects %s before contacting voice-hub', async (_label, body, status) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await POST(request(body));
    expect(response.status).toBe(status);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns the mutation guard denial without contacting voice-hub', async () => {
    guard.denied = Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await POST(request({ text: 'hello' }));
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

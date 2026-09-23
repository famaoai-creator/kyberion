import { NextRequest, NextResponse } from 'next/server';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { optionalRequestString, readRequestObject } from '../../../../lib/request-input';
import { voiceHubUrl } from '../../../../lib/voice-hub';

export const dynamic = 'force-dynamic';

/**
 * PA-09 return-audio TTS — proxies voice-hub POST /api/speech/synthesize so
 * the 秘書室 dock can play a reply in the browser (Web Audio → AnalyserNode →
 * talking-avatar mouth) instead of on the host speakers. Guarded like the
 * other voice write routes (it spends host TTS compute). The WAV bytes are
 * streamed back with `Cache-Control: no-store` and never persisted here.
 *
 * Status contract (the browser player falls back to speechSynthesis on any
 * non-200): 200 audio/wav · 400 invalid body · 413 text too long ·
 * 501 synthesis unsupported on the host · 502 bad upstream · 503 daemon down.
 */
export const VOICE_SYNTHESIZE_MAX_TEXT_CHARS = 2000;
const VOICE_SYNTHESIZE_MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const SYNTHESIZE_TIMEOUT_MS = 90_000;

const FORWARDED_HEADERS: ReadonlyArray<[string, RegExp]> = [
  ['x-kyberion-speech-engine', /^[A-Za-z0-9_.:-]{1,64}$/],
  ['x-kyberion-speech-duration-ms', /^\d{1,9}$/],
  ['x-kyberion-speech-language', /^(ja|en)$/],
];

function noStoreJson(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;

  const parsedBody = await readRequestObject(req, 'request body', ['text', 'language']);
  if (!parsedBody.ok) return noStoreJson({ ok: false, error: 'invalid request body' }, 400);
  let text: string;
  let language: string | undefined;
  try {
    text = optionalRequestString(parsedBody.body, 'text')?.trim() || '';
    language = optionalRequestString(parsedBody.body, 'language')?.trim() || undefined;
  } catch {
    return noStoreJson({ ok: false, error: 'invalid request body' }, 400);
  }
  if (!text || (language && !/^(ja|en)([-_][A-Za-z0-9]{1,8})?$/.test(language))) {
    return noStoreJson({ ok: false, error: 'invalid request body' }, 400);
  }
  if (text.length > VOICE_SYNTHESIZE_MAX_TEXT_CHARS) {
    return noStoreJson({ ok: false, error: 'text_too_long' }, 413);
  }

  let response: Response;
  try {
    response = await fetch(`${voiceHubUrl()}/api/speech/synthesize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(language ? { text, language } : { text }),
      signal: AbortSignal.timeout(SYNTHESIZE_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    return noStoreJson({ ok: false, error: 'voice_hub_unreachable' }, 503);
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (response.ok && contentType.startsWith('audio/wav')) {
    if (Number(response.headers.get('content-length') || 0) > VOICE_SYNTHESIZE_MAX_AUDIO_BYTES) {
      return noStoreJson({ ok: false, error: 'audio_too_large' }, 502);
    }
    const audio = await response.arrayBuffer();
    if (audio.byteLength > VOICE_SYNTHESIZE_MAX_AUDIO_BYTES || audio.byteLength < 12) {
      return noStoreJson({ ok: false, error: 'invalid_audio' }, 502);
    }
    const headers = new Headers({
      'Content-Type': 'audio/wav',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    for (const [name, pattern] of FORWARDED_HEADERS) {
      const value = response.headers.get(name);
      if (value && pattern.test(value)) headers.set(name, value);
    }
    return new NextResponse(audio, { status: 200, headers });
  }
  if (contentType.includes('application/json')) {
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const error = typeof payload?.error === 'string' ? payload.error.slice(0, 80) : undefined;
    const reason = typeof payload?.reason === 'string' ? payload.reason.slice(0, 200) : undefined;
    return noStoreJson(
      {
        ok: false,
        error: error || `voice_hub_http_${response.status}`,
        ...(reason ? { reason } : {}),
      },
      response.ok ? 502 : response.status
    );
  }
  return noStoreJson({ ok: false, error: 'invalid_voice_hub_response' }, 502);
}

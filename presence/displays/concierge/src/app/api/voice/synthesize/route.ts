import { NextRequest, NextResponse } from 'next/server';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { optionalRequestString, readRequestObject } from '../../../../lib/request-input';
import { voiceHubUrl } from '../../../../lib/voice-hub';

export const dynamic = 'force-dynamic';

/**
 * PA-09 return-audio TTS — proxies voice-hub POST /api/speech/synthesize so
 * the 秘書室 dock can play a reply in the browser (Web Audio → AnalyserNode →
 * talking-avatar mouth) instead of on the host speakers. The WAV bytes are
 * streamed back with `Cache-Control: no-store` and never persisted here.
 *
 * Access: `requireConciergeMutationAccess`, the same guard as every other
 * concierge voice write route (`listen-once`, `stop`, `selection`). It spends
 * host TTS compute, so it gets the write guard (same-origin / CSRF check,
 * rate limit, and a bearer token must resolve to a localadmin viewer). It
 * reads no personal-tier data, so the loopback-owner-only guard of the avatar
 * routes is not needed here.
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

/** voice-hub `/api/speech/synthesize` error codes a client may see. */
const UPSTREAM_ERRORS = new Set([
  'invalid_request',
  'text_too_long',
  'synthesis_busy',
  'synthesis_unsupported',
  'synthesis_failed',
  'synthesis_artifact_invalid',
]);
const REASON_CODE = /^[a-z0-9_]{1,80}$/u;

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
    // Only known error codes and snake_case reason codes pass through —
    // never upstream free text (stderr, paths).
    const error =
      typeof payload?.error === 'string' && UPSTREAM_ERRORS.has(payload.error)
        ? payload.error
        : undefined;
    const reason =
      typeof payload?.reason === 'string' && REASON_CODE.test(payload.reason)
        ? payload.reason
        : undefined;
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

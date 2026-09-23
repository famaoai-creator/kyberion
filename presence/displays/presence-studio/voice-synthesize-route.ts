// PA-09: `POST /api/voice/synthesize` — proxies voice-hub
// `POST /api/speech/synthesize` so the 相棒 page can play the reply in the
// browser (Web Audio → AnalyserNode → talking-avatar mouth) instead of only on
// the host speakers. See satellites/voice-hub/speech-synthesis.ts for the
// upstream contract and PADS_A2UI_AND_AVATAR_PLAN_2026-09-23 §6.
//
// Guards: registered after the `/api` guard + rate limiter
// (presence-studio-runtime-data.ts) like every other voice route, and — since
// it spends host TTS compute — additionally requires the server-derived
// loopback localadmin viewer (a remote token viewer gets 403). The audio is
// never cached (`Cache-Control: no-store`) and never written to disk here.
import type express from 'express';
import { z } from 'zod';
import { logger } from '@agent/core/core';
import {
  PresenceStudioViewerError,
  requirePresenceStudioLocalAdmin,
  resolvePresenceStudioViewerContext,
} from './security.js';
import * as presenceStudioData from './presence-studio-runtime-data.js';

/** Same cap as voice-hub `SPEECH_SYNTHESIZE_MAX_TEXT_CHARS`. */
export const VOICE_SYNTHESIZE_MAX_TEXT_CHARS = 2000;
/** Same cap as voice-hub `SPEECH_SYNTHESIZE_MAX_AUDIO_BYTES`. */
export const VOICE_SYNTHESIZE_MAX_AUDIO_BYTES = 24 * 1024 * 1024;
/** Synthesis of a long reply with a local model can take a while. */
export const VOICE_SYNTHESIZE_TIMEOUT_MS = 90_000;

export const presenceStudioVoiceSynthesizeSchema = z
  .object({
    text: z.string().trim().min(1).max(VOICE_SYNTHESIZE_MAX_TEXT_CHARS),
    language: z
      .string()
      .trim()
      .regex(/^(ja|en)([-_][A-Za-z0-9]{1,8})?$/)
      .optional(),
  })
  .strict();

const FORWARDED_HEADERS: ReadonlyArray<[string, RegExp]> = [
  ['x-kyberion-speech-engine', /^[A-Za-z0-9_.:-]{1,64}$/],
  ['x-kyberion-speech-duration-ms', /^\d{1,9}$/],
  ['x-kyberion-speech-language', /^(ja|en)$/],
];

export type VoiceSynthesizeProxyResult =
  | { kind: 'audio'; audio: Buffer; headers: Record<string, string> }
  | { kind: 'json'; status: number; body: Record<string, unknown> };

/**
 * Normalize a voice-hub synthesize response: WAV bytes pass through with the
 * validated timing headers; JSON errors pass through as a small typed shape
 * (status kept, so 501 still means "fall back"); anything else is 502.
 */
export async function readVoiceSynthesizeUpstream(
  response: Response
): Promise<VoiceSynthesizeProxyResult> {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (response.ok && contentType.startsWith('audio/wav')) {
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > VOICE_SYNTHESIZE_MAX_AUDIO_BYTES) {
      return { kind: 'json', status: 502, body: { ok: false, error: 'audio_too_large' } };
    }
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.byteLength > VOICE_SYNTHESIZE_MAX_AUDIO_BYTES || audio.byteLength < 12) {
      return { kind: 'json', status: 502, body: { ok: false, error: 'invalid_audio' } };
    }
    const headers: Record<string, string> = {};
    for (const [name, pattern] of FORWARDED_HEADERS) {
      const value = response.headers.get(name);
      if (value && pattern.test(value)) headers[name] = value;
    }
    return { kind: 'audio', audio, headers };
  }
  if (contentType.includes('application/json')) {
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const error =
      payload && typeof payload.error === 'string' ? payload.error.slice(0, 80) : undefined;
    const reason =
      payload && typeof payload.reason === 'string' ? payload.reason.slice(0, 200) : undefined;
    return {
      kind: 'json',
      status: response.ok ? 502 : response.status,
      body: {
        ok: false,
        error: error || `voice_hub_http_${response.status}`,
        ...(reason ? { reason } : {}),
      },
    };
  }
  return {
    kind: 'json',
    status: 502,
    body: { ok: false, error: 'invalid_voice_hub_response' },
  };
}

export interface VoiceSynthesizeRouteDeps {
  voiceHubUrl?: string;
  fetchImpl?: typeof fetch;
}

export function registerVoiceSynthesizeRoute(
  app: express.Express,
  deps: VoiceSynthesizeRouteDeps = {}
): void {
  app.post('/api/voice/synthesize', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      requirePresenceStudioLocalAdmin(resolvePresenceStudioViewerContext(req));
    } catch (error) {
      const status = error instanceof PresenceStudioViewerError ? error.status : 403;
      return res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
    }
    const parsed = presenceStudioVoiceSynthesizeSchema.safeParse(
      presenceStudioData.safeParsePresenceStudioRequestBody(req.body, 'voice synthesize body')
    );
    if (!parsed.success) {
      const tooLong = parsed.error.issues.some((issue) => issue.code === 'too_big');
      return res.status(tooLong ? 413 : 400).json({
        ok: false,
        error: tooLong ? 'text_too_long' : presenceStudioData.validationErrorMessage(parsed.error),
      });
    }
    const voiceHubUrl = deps.voiceHubUrl ?? presenceStudioData.VOICE_HUB_URL;
    const fetchImpl = deps.fetchImpl ?? fetch;
    let result: VoiceSynthesizeProxyResult;
    try {
      const response = await fetchImpl(`${voiceHubUrl}/api/speech/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(VOICE_SYNTHESIZE_TIMEOUT_MS),
      });
      result = await readVoiceSynthesizeUpstream(response);
    } catch (error) {
      logger.warn(
        presenceStudioData.presenceStudioAuditLine(req, 'voice/synthesize.error', {
          error: error instanceof Error ? error.message : String(error),
        })
      );
      return res.status(503).json({ ok: false, error: 'voice_hub_unreachable' });
    }
    logger.info(
      presenceStudioData.presenceStudioAuditLine(req, 'voice/synthesize.complete', {
        status: result.kind === 'audio' ? 200 : result.status,
        chars: parsed.data.text.length,
        bytes: result.kind === 'audio' ? result.audio.byteLength : undefined,
      })
    );
    if (result.kind === 'json') return res.status(result.status).json(result.body);
    res.status(200);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    return res.end(result.audio);
  });
}

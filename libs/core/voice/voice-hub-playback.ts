/**
 * Voice-hub playback delegate — hands a synthesized artifact to the voice-hub
 * daemon for host playback so `GET /api/speech/state` (and every surface that
 * polls it, e.g. the presence-studio talking avatar) tracks what is spoken.
 *
 * `POST /api/speech/play` blocks until playback finishes or is interrupted by
 * `POST /api/stop-speaking`, so `done` is just the request resolving and
 * `stop()` is a second request that releases the first.
 */

import { resolveSurfaceUrl } from '../surface/surface-url.js';
import type { PlaybackHandle, PlaybackResult } from './audio-playback.js';

export interface VoiceHubPlaybackOptions {
  /** voice-hub base URL. Default: the governed surface URL for `voice-hub`. */
  baseUrl?: string;
  /** Optional label recorded in voice-hub speech state (display only). */
  text?: string;
  /**
   * Max wait for a single segment's playback. The route blocks until the
   * clip ends, so a wedged player would otherwise stall the turn forever.
   * Default 120s — far beyond the ~20s a 120-char segment can produce.
   */
  timeoutMs?: number;
}

interface VoiceHubPlayResponse {
  ok?: boolean;
  error?: string;
}

async function postVoiceHub(
  baseUrl: string,
  route: string,
  body: unknown,
  signal?: AbortSignal
): Promise<Response> {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Returns a `play` callback compatible with `RealtimeVoiceLoopOptions.play`
 * and `speakSegmented`-style callers: each artifact is played by voice-hub on
 * the host speakers, and `stop()` maps to voice-hub's barge-in stop.
 */
export function createVoiceHubSegmentPlayback(
  options: VoiceHubPlaybackOptions = {}
): (audioPath: string, segmentIndex: number) => PlaybackHandle {
  // Strip trailing slashes without a regex — CodeQL flags `replace(/\/+$/, '')`
  // on caller-controlled input as polynomial-on-uncontrolled-data.
  let baseUrl = options.baseUrl || resolveSurfaceUrl('voice-hub');
  while (baseUrl.endsWith('/')) {
    baseUrl = baseUrl.slice(0, -1);
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  return (audioPath: string) => {
    let interrupted = false;
    const done: Promise<PlaybackResult> = (async () => {
      const timeout = AbortSignal.timeout(timeoutMs);
      try {
        const response = await postVoiceHub(
          baseUrl,
          '/api/speech/play',
          {
            audio_path: audioPath,
            ...(options.text !== undefined ? { text: options.text } : {}),
          },
          timeout
        );
        const payload = (await response.json().catch(() => ({}))) as VoiceHubPlayResponse;
        if (!response.ok || payload.ok === false) {
          return {
            ok: false,
            interrupted,
            error: payload.error || `voice_hub_play_http_${response.status}`,
          };
        }
        return { ok: true, interrupted };
      } catch (error) {
        // The timed-out request leaves playback running on the host — ask
        // the hub to stop it, then report the turn as failed.
        if (timeout.aborted) {
          await postVoiceHub(baseUrl, '/api/stop-speaking', {
            reason: 'playback_timeout',
          }).catch(() => {});
          return { ok: false, interrupted: true, error: 'voice_hub_play_timeout' };
        }
        return {
          ok: false,
          interrupted,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })();
    return {
      done,
      stop: async () => {
        interrupted = true;
        try {
          await postVoiceHub(baseUrl, '/api/stop-speaking', { reason: 'barge_in' });
        } catch {
          /* best effort — playback may have already finished */
        }
        return done;
      },
    };
  };
}

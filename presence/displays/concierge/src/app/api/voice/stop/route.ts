import { NextRequest, NextResponse } from 'next/server';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { voiceHubUrl } from '../../../../lib/voice-hub';
import { parseVoiceStopResponse } from '../../../../lib/voice-types';

export const dynamic = 'force-dynamic';

/**
 * CS-02 barge-in — stops the server-side TTS playback via voice-hub
 * POST /api/stop-speaking (returns {ok, stopped, reason}). Failing to reach
 * the daemon is not an error worth surfacing loudly: if voice-hub is down,
 * nothing is speaking anyway.
 */
const STOP_TIMEOUT_MS = 3000;

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;

  try {
    const response = await fetch(`${voiceHubUrl()}/api/stop-speaking`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'concierge_manual_stop' }),
      signal: AbortSignal.timeout(STOP_TIMEOUT_MS),
    });
    const payload = parseVoiceStopResponse(await response.json().catch(() => null));
    if (!payload) {
      return NextResponse.json(
        { ok: false, stopped: false, reason: 'invalid_voice_hub_response' },
        { status: response.ok ? 502 : response.status }
      );
    }
    return NextResponse.json(payload, { status: response.ok ? 200 : response.status });
  } catch {
    // Daemon unreachable — treat as "already stopped".
    return NextResponse.json({ ok: true, stopped: false, reason: 'voice_hub_unreachable' });
  }
}

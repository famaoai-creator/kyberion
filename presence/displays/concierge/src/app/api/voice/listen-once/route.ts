import { NextRequest, NextResponse } from 'next/server';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { voiceHubUrl } from '../../../../lib/voice-hub';

export const dynamic = 'force-dynamic';

/**
 * CS-02 Tier-1 mic turn — proxies one server-side capture through voice-hub
 * POST /api/listen-once (record → native STT → reply → server TTS). The
 * voice-hub JSON is passed through verbatim (status code included) so the
 * client sees the real `stt.text` transcript, `replyText`, and `spoken`
 * fields exactly as satellites/voice-hub/server.ts produced them.
 *
 * The timeout is generous: the default capture window alone is 8 s and
 * STT + reply generation come on top of it.
 */
const LISTEN_ONCE_TIMEOUT_MS = 30_000;

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const backend =
    typeof body.backend === 'string' && body.backend.trim() ? body.backend.trim() : undefined;
  const device =
    typeof body.device === 'string' && body.device.trim() ? body.device.trim() : undefined;
  const locale =
    typeof body.locale === 'string' && body.locale.trim() ? body.locale.trim() : 'ja-JP';

  try {
    const response = await fetch(`${voiceHubUrl()}/api/listen-once`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        locale,
        backend,
        device_id: device,
        intent: 'conversation',
        speaker: 'Sovereign',
        reflect_to_surface: true,
        // auto_reply true = voice-hub generates AND speaks the reply
        // server-side; the browser must not speak it a second time.
        auto_reply: true,
      }),
      signal: AbortSignal.timeout(LISTEN_ONCE_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!payload) {
      return NextResponse.json(
        { ok: false, error: `voice-hub responded ${response.status} without JSON` },
        { status: 502 }
      );
    }
    return NextResponse.json(payload, { status: response.status });
  } catch (error) {
    // Daemon down or capture timed out — a clear machine-readable failure the
    // hook maps to a polite notice (never an unhandled exception).
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 503 }
    );
  }
}

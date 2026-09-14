import { NextRequest, NextResponse } from 'next/server';
import { resolveConciergeViewer } from '../../../../lib/viewer-context';
import { presenceStudioUrl } from '../../../../lib/presence-studio-url';

export const dynamic = 'force-dynamic';
const TIMEOUT_MS = 3000;

/**
 * HT-05 read-only proxy for the governed training catalog (track ids,
 * titles, lessons) — the settings 組織とメンバー pane lists tracks from here
 * rather than hardcoding track titles client-side. Guarded like every other
 * read route (resolveConciergeViewer); never mutates.
 */
export async function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const response = await fetch(`${presenceStudioUrl()}/api/training/catalog`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({ ok: false, error: 'invalid response' }));
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json({ ok: false, error: 'presence_studio_unavailable' }, { status: 503 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { loadTrainingCatalog } from '@agent/core/training-catalog';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

/**
 * HT-05 read-only governed training catalog (track ids, titles, lessons) —
 * the settings 組織とメンバー pane lists tracks from here rather than
 * hardcoding track titles client-side. Read in-process (it used to be proxied
 * to presence-studio); guarded like every other read route.
 */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    return NextResponse.json(
      { ok: true, catalog: loadTrainingCatalog() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}

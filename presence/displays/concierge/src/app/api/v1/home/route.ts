import { NextRequest, NextResponse } from 'next/server';
import { collectHomeDashboard } from '../../../../lib/home-dashboard';
import { resolveConciergeSelectedViewer } from '../../../../lib/selected-tenant';
import { conciergeErrorResponse, guardConciergeRequest } from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/**
 * ホーム dashboard: every tile from one server-side snapshot
 * (`lib/home-dashboard.ts`). The viewer is resolved server-side; the shell's
 * company selection (URL / cookie hint, re-validated) only narrows it. With
 * no company selected the operator sees their whole authorized scope — the
 * overview of everything they may see — exactly like `/api/v1/workspace/summary`.
 */
export function GET(req: NextRequest) {
  const limited = guardConciergeRequest(req);
  if (limited) return limited;
  const resolved = resolveConciergeSelectedViewer(req);
  if (resolved.response) return resolved.response;
  const viewer = resolved.selection.mode === 'personal' ? resolved.viewer : resolved.context;
  try {
    return NextResponse.json(
      { ok: true, data: collectHomeDashboard(viewer) },
      { headers: NO_STORE }
    );
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}

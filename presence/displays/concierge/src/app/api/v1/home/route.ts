import { NextRequest, NextResponse } from 'next/server';
import { collectHomeDashboard, countsOnlyHomeDashboard } from '../../../../lib/home-dashboard';
import { resolveConciergeSelectedViewer } from '../../../../lib/selected-tenant';
import { conciergeErrorResponse, guardConciergeRequest } from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/**
 * ホーム dashboard: every tile from one server-side snapshot
 * (`lib/home-dashboard.ts`). The viewer is resolved server-side; the shell's
 * company selection (URL / cookie hint, re-validated) only narrows it. With
 * no company selected (the personal view) the tiles count across the whole
 * authorized scope but carry no company's titles (`countsOnlyHomeDashboard`).
 */
export function GET(req: NextRequest) {
  const limited = guardConciergeRequest(req);
  if (limited) return limited;
  const resolved = resolveConciergeSelectedViewer(req);
  if (resolved.response) return resolved.response;
  // The personal (all-company) view counts across every company the viewer may
  // see, but shows no single company's detail (applyTenantSelection).
  const personal = resolved.selection.mode === 'personal';
  const viewer = personal ? resolved.viewer : resolved.context;
  try {
    const dashboard = collectHomeDashboard(viewer);
    return NextResponse.json(
      { ok: true, data: personal ? countsOnlyHomeDashboard(dashboard) : dashboard },
      { headers: NO_STORE }
    );
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}

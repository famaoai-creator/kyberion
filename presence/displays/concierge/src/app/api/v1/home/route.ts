import { NextRequest, NextResponse } from 'next/server';
import { collectHomeDashboard, countsOnlyHomeDashboard } from '../../../../lib/home-dashboard';
import { resolveConciergeSelectedViewer } from '../../../../lib/selected-tenant';
import {
  conciergeErrorResponse,
  guardConciergeRequest,
  narrowConciergeScope,
} from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/**
 * ホーム dashboard: every tile from one server-side snapshot
 * (`lib/home-dashboard.ts`). The viewer is resolved server-side; the shell's
 * company selection (URL / cookie hint, re-validated) only narrows it. With
 * no company selected (the personal view) the tiles count across the whole
 * authorized scope but carry no company's titles (`countsOnlyHomeDashboard`).
 * With a company selected, `organization_id` + `project_id` narrow the tiles
 * to one project (outside the viewer's scope → 403); missions that record no
 * project are left out, as on the 仕事 board and in あなた待ち.
 */
export function GET(req: NextRequest) {
  const limited = guardConciergeRequest(req);
  if (limited) return limited;
  const resolved = resolveConciergeSelectedViewer(req);
  if (resolved.response) return resolved.response;
  // The personal (all-company) view counts across every company the viewer may
  // see, but shows no single company's detail (applyTenantSelection).
  const personal = resolved.selection.mode === 'personal';
  const params = req.nextUrl.searchParams;
  const projectId = personal ? '' : params.get('project_id')?.trim() || '';
  const viewer = personal ? resolved.viewer : resolved.context;
  if (projectId) {
    // Validates the narrowing only (outside the viewer's scope → 403). The
    // dashboard keeps the authorized viewer and applies the project as a
    // focus, so the company's own tiles (key results) stay available.
    try {
      narrowConciergeScope(viewer, {
        organizationId: params.get('organization_id')?.trim() || null,
        projectId,
      });
    } catch (error) {
      return conciergeErrorResponse(error);
    }
  }
  try {
    const dashboard = collectHomeDashboard(viewer, Date.now(), projectId ? { projectId } : {});
    return NextResponse.json(
      { ok: true, data: personal ? countsOnlyHomeDashboard(dashboard) : dashboard },
      { headers: NO_STORE }
    );
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}

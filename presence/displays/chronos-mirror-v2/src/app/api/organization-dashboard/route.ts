import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { resolveViewerContextForRequest, viewerErrorResponse } from '../../../lib/viewer-context';
import { workspaceSelectionFromSearchParams } from '../../../lib/workspace-scope';
import {
  collectOrganizationDashboard,
  type DashboardMode,
} from '../../../lib/organization-dashboard';

export const dynamic = 'force-dynamic';
export function GET(req: NextRequest) {
  const denied = guardRequest(req) ?? requireChronosAccess(req, 'readonly');
  if (denied) return denied;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const modes = req.nextUrl.searchParams.getAll('mode');
  const mode = modes[0] || 'scope';
  if (modes.length > 1 || !['organization', 'scope', 'mine'].includes(mode))
    return NextResponse.json({ ok: false, error: 'Invalid dashboard mode.' }, { status: 400 });
  try {
    return NextResponse.json(
      collectOrganizationDashboard(
        resolvedViewer.context,
        workspaceSelectionFromSearchParams(req.nextUrl.searchParams),
        mode as DashboardMode
      ),
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    return viewerErrorResponse(error);
  }
}

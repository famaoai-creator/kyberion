import { NextRequest, NextResponse } from 'next/server';
import { guardOpsRequest, requireOpsAccess } from '../../../../lib/ops/ops-request-guard';
import { resolveOpsViewerForRequest, viewerErrorResponse } from '../../../../lib/ops/ops-viewer';
import { workspaceSelectionFromSearchParams } from '../../../../lib/ops/workspace-scope';
import {
  collectOrganizationDashboard,
  type DashboardMode,
} from '../../../../lib/ops/organization-dashboard';

export const dynamic = 'force-dynamic';
export function GET(req: NextRequest) {
  const denied = guardOpsRequest(req) ?? requireOpsAccess(req, 'readonly');
  if (denied) return denied;
  const resolvedViewer = resolveOpsViewerForRequest(req);
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

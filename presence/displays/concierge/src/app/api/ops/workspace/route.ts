import { NextRequest, NextResponse } from 'next/server';
import { guardOpsRequest, requireOpsAccess } from '../../../../lib/ops/ops-request-guard';
import { resolveOpsViewerForRequest, viewerErrorResponse } from '../../../../lib/ops/ops-viewer';
import { collectWorkspaceOverview } from '../../../../lib/ops/workspace-overview';
import { workspaceSelectionFromSearchParams } from '../../../../lib/ops/workspace-scope';
export const dynamic = 'force-dynamic';
export function GET(req: NextRequest) {
  const denied = guardOpsRequest(req) ?? requireOpsAccess(req, 'readonly');
  if (denied) return denied;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  try {
    return NextResponse.json({
      ok: true,
      ...collectWorkspaceOverview(
        resolvedViewer.context,
        workspaceSelectionFromSearchParams(req.nextUrl.searchParams)
      ),
    });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { guardOpsRequest, requireOpsAccess } from '../../../../lib/ops/ops-request-guard';
import { resolveOpsViewerForRequest, viewerErrorResponse } from '../../../../lib/ops/ops-viewer';
import { workspaceSelectionFromSearchParams } from '../../../../lib/ops/workspace-scope';
import { collectInformationAssets } from '../../../../lib/ops/information-assets';
export const dynamic = 'force-dynamic';
export function GET(req: NextRequest) {
  const denied = guardOpsRequest(req) ?? requireOpsAccess(req, 'readonly');
  if (denied) return denied;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  try {
    return NextResponse.json(
      collectInformationAssets(
        resolvedViewer.context,
        workspaceSelectionFromSearchParams(req.nextUrl.searchParams)
      ),
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    return viewerErrorResponse(error);
  }
}

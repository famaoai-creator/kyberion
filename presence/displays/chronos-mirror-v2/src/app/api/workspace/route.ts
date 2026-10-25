import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { resolveViewerContextForRequest, viewerErrorResponse } from '../../../lib/viewer-context';
import { collectWorkspaceOverview } from '../../../lib/workspace-overview';
import { workspaceSelectionFromSearchParams } from '../../../lib/workspace-scope';
export const dynamic = 'force-dynamic';
export function GET(req: NextRequest) {
  const denied = guardRequest(req) ?? requireChronosAccess(req, 'readonly');
  if (denied) return denied;
  const resolvedViewer = resolveViewerContextForRequest(req);
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

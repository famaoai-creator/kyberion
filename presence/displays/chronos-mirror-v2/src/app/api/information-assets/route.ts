import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { resolveViewerContextForRequest, viewerErrorResponse } from '../../../lib/viewer-context';
import { workspaceSelectionFromSearchParams } from '../../../lib/workspace-scope';
import { collectInformationAssets } from '../../../lib/information-assets';
export const dynamic = 'force-dynamic';
export function GET(req: NextRequest) {
  const denied = guardRequest(req) ?? requireChronosAccess(req, 'readonly');
  if (denied) return denied;
  const resolvedViewer = resolveViewerContextForRequest(req);
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

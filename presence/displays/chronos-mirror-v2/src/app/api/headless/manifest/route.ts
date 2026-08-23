import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
} from '../../../../lib/viewer-context';
import { headlessManifestForViewer } from '../../../../lib/headless-response';
import { headlessViewerScope } from '../../../../lib/headless-projections';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const access = requireChronosAccess(req, 'readonly');
  if (access) return access;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    return NextResponse.json({
      ok: true,
      manifest: headlessManifestForViewer(resolvedViewer.context),
      viewer: {
        role: resolvedViewer.context.role,
        principal_id: resolvedViewer.context.principalId,
        scope: headlessViewerScope(resolvedViewer.context),
      },
    });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}

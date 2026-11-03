import { NextRequest, NextResponse } from 'next/server';
import { guardOpsRequest, requireOpsAccess } from '../../../../../lib/ops/ops-request-guard';
import { resolveOpsViewerForRequest, viewerErrorResponse } from '../../../../../lib/ops/ops-viewer';
import { headlessManifestForViewer } from '../../../../../lib/ops/headless-response';
import { headlessViewerScope } from '../../../../../lib/ops/headless-projections';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const access = requireOpsAccess(req, 'readonly');
  if (access) return access;
  const resolvedViewer = resolveOpsViewerForRequest(req);
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

import { NextRequest, NextResponse } from 'next/server';
import { guardOpsRequest, requireOpsAccess } from '../../../../../lib/ops/ops-request-guard';
import { resolveOpsViewerForRequest, viewerErrorResponse } from '../../../../../lib/ops/ops-viewer';
import { readChronosOptionalStringParam } from '../../../../../lib/ops/request-input';
import { snapshotForViewer } from './helpers';

export function GET(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    const url = new URL(req.url);
    const missionId = readChronosOptionalStringParam(url.searchParams.get('mission_id'));
    const snapshot = snapshotForViewer(resolvedViewer.context, missionId);
    return NextResponse.json(
      { ok: true, ...snapshot },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    return viewerErrorResponse(error);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
} from '../../../../lib/viewer-context';
import { readChronosOptionalStringParam } from '../../../../lib/request-input';
import { snapshotForViewer } from './helpers';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
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

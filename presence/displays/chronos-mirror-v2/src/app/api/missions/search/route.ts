import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import { buildMissionHistoryItems } from '../../../../lib/su-surface-data';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  viewerScopeTenantSlugs,
} from '../../../../lib/viewer-context';
import {
  readChronosOptionalStringParam,
  readChronosStringParam,
} from '../../../../lib/request-input';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  const url = new URL(req.url);
  try {
    const tenantSlugs = viewerScopeTenantSlugs(
      resolvedViewer.context,
      readChronosOptionalStringParam(url.searchParams.get('tenant'))
    );
    const missions = buildMissionHistoryItems({
      query: readChronosOptionalStringParam(url.searchParams.get('query')),
      status: readChronosOptionalStringParam(url.searchParams.get('status')),
      tier: 'confidential',
      tenant: readChronosOptionalStringParam(url.searchParams.get('tenant')),
      tenantSlugs,
      kind: readChronosOptionalStringParam(url.searchParams.get('kind')),
      missionId: readChronosOptionalStringParam(url.searchParams.get('missionId')),
      limit: Number(readChronosStringParam(url.searchParams.get('limit')) || 24),
    });
    return NextResponse.json({ missions });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}

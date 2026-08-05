import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import { buildMissionHistoryItems } from '../../../../lib/su-surface-data';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  viewerScopeTenantSlugs,
} from '../../../../lib/viewer-context';

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
      url.searchParams.get('tenant') || undefined
    );
    const missions = buildMissionHistoryItems({
      query: url.searchParams.get('query') || undefined,
      status: url.searchParams.get('status') || undefined,
      tier: 'confidential',
      tenant: url.searchParams.get('tenant') || undefined,
      tenantSlugs,
      kind: url.searchParams.get('kind') || undefined,
      missionId: url.searchParams.get('missionId') || undefined,
      limit: Number(url.searchParams.get('limit') || 24),
    });
    return NextResponse.json({ missions });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}
